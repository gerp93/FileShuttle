import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunProgress, runMapping } from './mover';
import { listTree, makeMapping, makeTempDir, removeDir, writeFile } from './testUtils';

let root: string;
let src: string;
let dest: string;
let trashed: string[];
const trash = async (p: string) => {
  trashed.push(p);
  fs.rmSync(p, { recursive: true, force: true });
};

beforeEach(() => {
  root = makeTempDir();
  src = path.join(root, 'src');
  dest = path.join(root, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  trashed = [];
});
afterEach(() => removeDir(root));

describe('large folders', () => {
  it('moves thousands of files across many subfolders, preserving structure', async () => {
    const folders = 25;
    const perFolder = 80;
    for (let f = 0; f < folders; f += 1) {
      for (let i = 0; i < perFolder; i += 1) writeFile(path.join(src, `d${f}`, `f${i}.txt`), 'x');
    }

    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, recursive: true }), { trash });

    expect(result.filesMoved).toBe(folders * perFolder);
    expect(result.filesErrored).toBe(0);
    expect(listTree(src)).toEqual([]);
    expect(listTree(dest)).toHaveLength(folders * perFolder);
    expect(fs.existsSync(path.join(dest, 'd24', 'f79.txt'))).toBe(true);
  }, 60_000);
});

describe('progress reporting', () => {
  it('reports scanning, then processing with a known total, ending at total/total', async () => {
    for (let i = 0; i < 30; i += 1) writeFile(path.join(src, `f${i}.txt`));
    const events: RunProgress[] = [];

    await runMapping(makeMapping({ sourcePath: src, destPath: dest }), {
      trash,
      onProgress: (p) => events.push({ ...p }),
    });

    const processing = events.filter((e) => e.phase === 'processing');
    expect(processing.length).toBeGreaterThan(0);
    expect(processing[0]).toMatchObject({ processed: 0, total: 30 });
    expect(processing[processing.length - 1]).toMatchObject({ processed: 30, total: 30 });
    // Counts only ever go up.
    for (let i = 1; i < processing.length; i += 1) {
      expect(processing[i].processed).toBeGreaterThanOrEqual(processing[i - 1].processed);
    }
  });

  it('counts only the files that survive filtering as the total', async () => {
    for (let i = 0; i < 10; i += 1) writeFile(path.join(src, `keep${i}.txt`));
    for (let i = 0; i < 5; i += 1) writeFile(path.join(src, `skip${i}.log`));
    const events: RunProgress[] = [];

    await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        filters: [{ field: 'extension', operator: 'equals', value: 'txt' }],
      }),
      { trash, onProgress: (p) => events.push({ ...p }) }
    );

    expect(events.find((e) => e.phase === 'processing')?.total).toBe(10);
  });
});

describe('cancellation', () => {
  it('stops before the next file and keeps what was already done', async () => {
    for (let i = 0; i < 10; i += 1) writeFile(path.join(src, `f${i}.tmp`));
    const controller = new AbortController();
    let calls = 0;

    const result = await runMapping(makeMapping({ sourcePath: src, actionType: 'delete' }), {
      signal: controller.signal,
      trash: async (p) => {
        await trash(p);
        calls += 1;
        if (calls === 3) controller.abort();
      },
    });

    expect(result.filesDeleted).toBe(3);
    expect(listTree(src)).toHaveLength(7);
  });

  it('does nothing when already cancelled', async () => {
    writeFile(path.join(src, 'a.txt'));
    const controller = new AbortController();
    controller.abort();

    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest }), {
      trash,
      signal: controller.signal,
    });

    expect(result.fileOutcomes).toEqual([]);
    expect(listTree(src)).toEqual(['a.txt']);
  });
});

describe('unzip limits', () => {
  const makeZip = (zipPath: string, files: Record<string, string | Buffer>) => {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
      zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
    }
    zip.writeZip(zipPath);
  };
  const unzip = (limits: { maxEntries: number; maxTotalBytes: number }, dryRun = false) =>
    runMapping(makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip' }), {
      trash,
      dryRun,
      unzipLimits: limits,
    });

  it('refuses an archive with too many entries, leaving the zip and creating nothing', async () => {
    makeZip(path.join(src, 'bundle.zip'), { 'a.txt': '1', 'b.txt': '2' });

    const result = await unzip({ maxEntries: 1, maxTotalBytes: 1e9 });

    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/Not extracted: the archive has more than 1 entries/);
    expect(fs.existsSync(path.join(src, 'bundle.zip'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'bundle'))).toBe(false);
    expect(trashed).toEqual([]);
  });

  it('refuses an archive that would expand beyond the size limit (a zip bomb)', async () => {
    makeZip(path.join(src, 'bomb.zip'), { 'zeros.bin': Buffer.alloc(500_000, 0) }); // tiny on disk
    expect(fs.statSync(path.join(src, 'bomb.zip')).size).toBeLessThan(5_000);

    const result = await unzip({ maxEntries: 100, maxTotalBytes: 100_000 });

    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/would expand to more than/);
    expect(fs.existsSync(path.join(dest, 'bomb'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'bomb.zip'))).toBe(true);
  });

  it('reports the same refusal in a preview, before anything runs', async () => {
    makeZip(path.join(src, 'bomb.zip'), { 'zeros.bin': Buffer.alloc(500_000, 0) });
    const result = await unzip({ maxEntries: 100, maxTotalBytes: 100_000 }, true);
    expect(result.filesErrored).toBe(1);
    expect(result.filesExtracted).toBe(0);
  });

  it('extracts normally when within the limits', async () => {
    makeZip(path.join(src, 'ok.zip'), { 'a.txt': '1' });
    const result = await unzip({ maxEntries: 100, maxTotalBytes: 1_000_000 });
    expect(result.filesExtracted).toBe(1);
    expect(listTree(dest)).toEqual(['ok/a.txt']);
  });
});
