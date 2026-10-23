import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTree, makeTempDir, removeDir, writeFile, writeZipWithRawEntryName } from './testUtils';
import {
  createZip,
  extractZipEntries,
  readZipEntries,
  resolveEntryTarget,
  UnsafeArchiveError,
  UnzipLimits,
} from './zipStream';

let root: string;
beforeEach(() => {
  root = makeTempDir('fileshuttle-zip-');
});
afterEach(() => removeDir(root));

const LIMITS: UnzipLimits = { maxEntries: 1000, maxTotalBytes: 1024 * 1024 };

function makeZip(zipPath: string, files: Record<string, string | Buffer>): void {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  zip.writeZip(zipPath);
}

async function extract(zipPath: string, target: string, limits = LIMITS): Promise<void> {
  const opened = await readZipEntries(zipPath, limits);
  try {
    await extractZipEntries(opened.zipfile, opened.entries, target, limits);
  } finally {
    opened.close();
  }
}

describe('resolveEntryTarget', () => {
  const base = path.resolve(root || '/base', 'out');

  it('keeps ordinary and nested names inside the folder', () => {
    expect(resolveEntryTarget(base, 'a.txt')).toBe(path.join(base, 'a.txt'));
    expect(resolveEntryTarget(base, 'dir/sub/b.txt')).toBe(path.join(base, 'dir', 'sub', 'b.txt'));
  });

  it('normalises backslashes from archives written on Windows', () => {
    expect(resolveEntryTarget(base, 'dir\\b.txt')).toBe(path.join(base, 'dir', 'b.txt'));
  });

  it('rejects traversal, absolute paths, and drive letters', () => {
    expect(resolveEntryTarget(base, '../evil.txt')).toBeNull();
    expect(resolveEntryTarget(base, 'a/../../evil.txt')).toBeNull();
    expect(resolveEntryTarget(base, 'C:\\Windows\\evil.txt')).toBeNull();
    expect(resolveEntryTarget(base, 'C:evil.txt')).toBeNull();
  });

  it('treats a leading slash as relative to the folder, never the filesystem root', () => {
    expect(resolveEntryTarget(base, '/etc/passwd')).toBe(path.join(base, 'etc', 'passwd'));
  });
});

describe('readZipEntries', () => {
  it('lists entries without extracting anything', async () => {
    const zipPath = path.join(root, 'a.zip');
    makeZip(zipPath, { 'one.txt': '1', 'dir/two.txt': '22' });
    const opened = await readZipEntries(zipPath, LIMITS);
    opened.close();
    expect(opened.entries.map((e) => e.name).sort()).toEqual(['dir/two.txt', 'one.txt']);
    expect(opened.entries.find((e) => e.name === 'dir/two.txt')?.uncompressedSize).toBe(2);
  });

  it('refuses an archive with too many entries', async () => {
    const zipPath = path.join(root, 'many.zip');
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) files[`f${i}.txt`] = 'x';
    makeZip(zipPath, files);
    await expect(readZipEntries(zipPath, { maxEntries: 10, maxTotalBytes: 1e9 })).rejects.toThrow(
      /more than 10 entries/
    );
  });

  it('refuses an archive that would expand beyond the size limit', async () => {
    const zipPath = path.join(root, 'big.zip');
    makeZip(zipPath, { 'big.bin': Buffer.alloc(200_000, 7) }); // compresses to almost nothing
    await expect(readZipEntries(zipPath, { maxEntries: 100, maxTotalBytes: 100_000 })).rejects.toBeInstanceOf(
      UnsafeArchiveError
    );
  });

  it('refuses an archive containing a path that escapes the folder', async () => {
    const zipPath = path.join(root, 'evil.zip');
    writeZipWithRawEntryName(zipPath, '../../evil.txt');
    await expect(readZipEntries(zipPath, LIMITS)).rejects.toThrow(/unsafe path/);
  });

  it('rejects a file that is not a zip', async () => {
    const bogus = writeFile(path.join(root, 'nope.zip'), 'not a zip');
    await expect(readZipEntries(bogus, LIMITS)).rejects.toThrow();
  });
});

describe('extractZipEntries', () => {
  it('extracts nested files, with content and timestamps', async () => {
    const zipPath = path.join(root, 'a.zip');
    makeZip(zipPath, { 'one.txt': 'ONE', 'dir/sub/two.txt': 'TWO' });
    const out = path.join(root, 'out');

    await extract(zipPath, out);

    expect(listTree(out)).toEqual(['dir/sub/two.txt', 'one.txt']);
    expect(fs.readFileSync(path.join(out, 'dir', 'sub', 'two.txt'), 'utf8')).toBe('TWO');
  });

  it('extracts files larger than a stream chunk intact', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 'abcdefghij');
    const zipPath = path.join(root, 'big.zip');
    makeZip(zipPath, { 'big.bin': big });
    const out = path.join(root, 'out');

    await extract(zipPath, out, { maxEntries: 10, maxTotalBytes: 10 * 1024 * 1024 });

    expect(fs.readFileSync(path.join(out, 'big.bin')).equals(big)).toBe(true);
  });

  it('can be cancelled between entries', async () => {
    const zipPath = path.join(root, 'a.zip');
    makeZip(zipPath, { 'one.txt': '1', 'two.txt': '2' });
    const controller = new AbortController();
    controller.abort();
    const opened = await readZipEntries(zipPath, LIMITS);
    try {
      await expect(
        extractZipEntries(opened.zipfile, opened.entries, path.join(root, 'out'), LIMITS, controller.signal)
      ).rejects.toThrow(/cancelled/);
    } finally {
      opened.close();
    }
  });
});

describe('createZip', () => {
  const readNames = (zipPath: string) =>
    new AdmZip(zipPath)
      .getEntries()
      .map((e) => e.entryName)
      .sort();

  it('zips a single file under its own name', async () => {
    const file = writeFile(path.join(root, 'in', 'note.txt'), 'hello');
    const out = path.join(root, 'note.txt.zip');
    await createZip(file, 'note.txt', false, out);
    expect(readNames(out)).toEqual(['note.txt']);
    expect(new AdmZip(out).readAsText('note.txt')).toBe('hello');
  });

  it('zips a folder recursively under the folder name, keeping empty directories', async () => {
    writeFile(path.join(root, 'proj', 'a.txt'), 'A');
    writeFile(path.join(root, 'proj', 'sub', 'b.txt'), 'B');
    fs.mkdirSync(path.join(root, 'proj', 'empty'));
    const out = path.join(root, 'proj.zip');

    await createZip(path.join(root, 'proj'), 'proj', true, out);

    expect(readNames(out)).toEqual(['proj/a.txt', 'proj/empty/', 'proj/sub/b.txt']);
  });

  it('zips an empty folder as a single directory entry', async () => {
    fs.mkdirSync(path.join(root, 'hollow'));
    const out = path.join(root, 'hollow.zip');
    await createZip(path.join(root, 'hollow'), 'hollow', true, out);
    expect(readNames(out)).toEqual(['hollow/']);
  });

  it('round-trips through extract', async () => {
    writeFile(path.join(root, 'proj', 'a.txt'), 'A');
    writeFile(path.join(root, 'proj', 'sub', 'b.txt'), 'B');
    const out = path.join(root, 'proj.zip');
    await createZip(path.join(root, 'proj'), 'proj', true, out);

    await extract(out, path.join(root, 'restored'));

    expect(listTree(path.join(root, 'restored'))).toEqual(['proj/a.txt', 'proj/sub/b.txt']);
  });

  it('leaves no partial archive or temp file behind when the source is missing', async () => {
    const out = path.join(root, 'ghost.zip');
    await expect(createZip(path.join(root, 'does-not-exist.txt'), 'x.txt', false, out)).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(root).filter((f) => f.includes('fileshuttle-tmp'))).toEqual([]);
  });
});
