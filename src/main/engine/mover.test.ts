import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileOutcome } from '../../shared/types';
import { resolveConflict, resolveDestination, runMapping } from './mover';
import { listTree, makeMapping, makeTempDir, removeDir, writeFile, writeZipWithRawEntryName } from './testUtils';

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

const outcomeOf = (outcomes: FileOutcome[], name: string) =>
  outcomes.find((o) => path.basename(o.sourcePath) === name);

describe('move', () => {
  it('moves matching files and leaves non-matching ones', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    writeFile(path.join(src, 'b.log'), 'B');
    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        filters: [{ field: 'extension', operator: 'equals', value: 'txt', group: 0 }],
      }),
      { trash }
    );
    expect(result.filesMoved).toBe(1);
    expect(listTree(src)).toEqual(['b.log']);
    expect(listTree(dest)).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('A');
  });

  it('picks up files that match any rule in a group and every group', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    writeFile(path.join(src, 'b.log'), 'B');
    writeFile(path.join(src, 'c.bin'), 'C');
    writeFile(path.join(src, 'report-d.txt'), 'D');
    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        // (txt OR log) AND name starts with "report"-or-"a"
        filters: [
          { field: 'extension', operator: 'equals', value: 'txt', group: 0 },
          { field: 'extension', operator: 'equals', value: 'log', group: 0 },
          { field: 'filename_glob', operator: 'matches', value: 'report*', group: 1 },
          { field: 'filename_glob', operator: 'matches', value: 'a*', group: 1 },
        ],
      }),
      { trash }
    );
    expect(result.filesMoved).toBe(2);
    expect(listTree(dest)).toEqual(['a.txt', 'report-d.txt']);
    expect(listTree(src)).toEqual(['b.log', 'c.bin']);
  });

  it('does not descend into subfolders unless recursive', async () => {
    writeFile(path.join(src, 'top.txt'));
    writeFile(path.join(src, 'sub', 'deep.txt'));
    const flat = await runMapping(makeMapping({ sourcePath: src, destPath: dest }), { trash });
    expect(flat.filesMoved).toBe(1);
    expect(listTree(src)).toEqual(['sub/deep.txt']);
  });

  it('preserves the relative folder structure when recursive', async () => {
    writeFile(path.join(src, 'top.txt'));
    writeFile(path.join(src, 'sub', 'deep.txt'));
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, recursive: true }), { trash });
    expect(result.filesMoved).toBe(2);
    expect(listTree(dest)).toEqual(['sub/deep.txt', 'top.txt']);
  });

  it('is a no-op (not an error) when the source folder does not exist', async () => {
    const result = await runMapping(
      makeMapping({ sourcePath: path.join(root, 'missing'), destPath: dest }),
      { trash }
    );
    expect(result.fileOutcomes).toEqual([]);
  });

  it('reports an error with the OS reason when the source cannot be listed', async () => {
    const notAFolder = path.join(root, 'file.txt');
    writeFile(notAFolder, 'x');
    const result = await runMapping(makeMapping({ sourcePath: notAFolder, destPath: dest }), { trash });
    expect(result.filesErrored).toBe(1);
    const [outcome] = result.fileOutcomes;
    expect(outcome.outcome).toBe('error');
    expect(outcome.sourcePath).toBe(notAFolder);
    expect(outcome.reason).toMatch(/Scanning the source folder stopped early: .*(ENOTDIR|not a directory)/i);
  });
});

describe('copy', () => {
  it('copies and keeps the originals, preserving mtime', async () => {
    const mtime = new Date('2020-01-02T03:04:05Z');
    writeFile(path.join(src, 'a.txt'), 'A', mtime);
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, actionType: 'copy' }), { trash });
    expect(result.filesCopied).toBe(1);
    expect(listTree(src)).toEqual(['a.txt']);
    expect(listTree(dest)).toEqual(['a.txt']);
    expect(Math.abs(fs.statSync(path.join(dest, 'a.txt')).mtimeMs - mtime.getTime())).toBeLessThan(2000);
  });
});

describe('conflict policies', () => {
  beforeEach(() => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
  });

  it('skip leaves both files and reports a skip', async () => {
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'skip' }),
      { trash }
    );
    expect(result.filesSkipped).toBe(1);
    expect(result.filesMoved).toBe(0);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('OLD');
    expect(listTree(src)).toEqual(['a.txt']);
  });

  it('overwrite replaces the destination file', async () => {
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' }),
      { trash }
    );
    expect(result.filesMoved).toBe(1);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('NEW');
  });

  it('auto_rename keeps both files', async () => {
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'auto_rename' }),
      { trash }
    );
    expect(result.filesMoved).toBe(1);
    expect(listTree(dest)).toEqual(['a (1).txt', 'a.txt']);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(dest, 'a (1).txt'), 'utf8')).toBe('NEW');
  });

  it('auto_rename picks the first free numbered name', async () => {
    writeFile(path.join(dest, 'a (1).txt'), 'OLD1');
    await runMapping(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'auto_rename' }), { trash });
    expect(listTree(dest)).toEqual(['a (1).txt', 'a (2).txt', 'a.txt']);
  });
});

describe('resolveConflict / resolveDestination', () => {
  it('rejects an unknown policy', async () => {
    await expect(resolveConflict('/x', 'bogus')).rejects.toThrow(/Unknown conflict policy/);
  });

  it('maps a source file to the same relative path under the destination', () => {
    expect(resolveDestination(path.join('/s'), path.join('/d'), path.join('/s', 'a', 'b.txt'))).toBe(
      path.join('/d', 'a', 'b.txt')
    );
  });
});

describe('delete', () => {
  it('sends matching files to the trash function', async () => {
    writeFile(path.join(src, 'a.tmp'));
    writeFile(path.join(src, 'b.keep'));
    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        actionType: 'delete',
        filters: [{ field: 'extension', operator: 'equals', value: 'tmp', group: 0 }],
      }),
      { trash }
    );
    expect(result.filesDeleted).toBe(1);
    expect(trashed.map((p) => path.basename(p))).toEqual(['a.tmp']);
    expect(listTree(src)).toEqual(['b.keep']);
  });

  it('records an error outcome when the trash call fails', async () => {
    writeFile(path.join(src, 'a.tmp'));
    const result = await runMapping(makeMapping({ sourcePath: src, actionType: 'delete' }), {
      trash: async () => {
        throw new Error('recycle bin unavailable');
      },
    });
    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/recycle bin unavailable/);
    expect(listTree(src)).toEqual(['a.tmp']);
  });
});

describe('keep newest', () => {
  it('leaves the newest N in place and moves the rest', async () => {
    writeFile(path.join(src, 'old.txt'), 'o', new Date('2020-01-01'));
    writeFile(path.join(src, 'mid.txt'), 'm', new Date('2021-01-01'));
    writeFile(path.join(src, 'new.txt'), 'n', new Date('2022-01-01'));
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, keepNewest: 1 }), { trash });
    expect(listTree(src)).toEqual(['new.txt']);
    expect(listTree(dest)).toEqual(['mid.txt', 'old.txt']);
    expect(outcomeOf(result.fileOutcomes, 'new.txt')?.reason).toBe('kept_newest');
  });

  it('is ignored for copy mappings', async () => {
    writeFile(path.join(src, 'a.txt'));
    writeFile(path.join(src, 'b.txt'));
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'copy', keepNewest: 1 }),
      { trash }
    );
    expect(result.filesCopied).toBe(2);
  });
});

describe('zip', () => {
  it('zips each top-level file and folder into its own archive, leaving originals', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    writeFile(path.join(src, 'folder', 'inner.txt'), 'I');
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, actionType: 'zip' }), { trash });
    expect(result.filesZipped).toBe(2);
    expect(listTree(src)).toEqual(['a.txt', 'folder/inner.txt']);
    expect(listTree(dest)).toEqual(['a.txt.zip', 'folder.zip']);
    const names = new AdmZip(path.join(dest, 'folder.zip')).getEntries().map((e) => e.entryName);
    expect(names).toContain('folder/inner.txt');
  });

  it('skips an existing archive under the skip policy', async () => {
    writeFile(path.join(src, 'a.txt'));
    writeFile(path.join(dest, 'a.txt.zip'), 'EXISTING');
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'zip', conflictPolicy: 'skip' }),
      { trash }
    );
    expect(result.filesSkipped).toBe(1);
    expect(fs.readFileSync(path.join(dest, 'a.txt.zip'), 'utf8')).toBe('EXISTING');
  });
});

describe('unzip', () => {
  const makeZip = (zipPath: string, files: Record<string, string>) => {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    zip.writeZip(zipPath);
  };

  it('extracts into a same-named subfolder and trashes the original zip', async () => {
    makeZip(path.join(src, 'bundle.zip'), { 'one.txt': '1', 'nested/two.txt': '2' });
    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        actionType: 'unzip',
        filters: [{ field: 'extension', operator: 'equals', value: 'zip', group: 0 }],
      }),
      { trash }
    );
    expect(result.filesExtracted).toBe(1);
    expect(listTree(dest)).toEqual(['bundle/nested/two.txt', 'bundle/one.txt']);
    expect(trashed.map((p) => path.basename(p))).toEqual(['bundle.zip']);
  });

  it('does not allow an entry to escape the extraction folder', async () => {
    writeZipWithRawEntryName(path.join(src, 'evil.zip'), '../../escaped.txt', 'pwned');
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip' }),
      { trash }
    );
    expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '..', 'escaped.txt'))).toBe(false);
    // The whole archive is refused rather than quietly "fixed", and the zip is kept.
    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/unsafe path/);
    expect(trashed).toEqual([]);
    expect(fs.existsSync(path.join(src, 'evil.zip'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'evil'))).toBe(false);
  });

  it('reports an error and keeps the zip when the archive is corrupt', async () => {
    writeFile(path.join(src, 'broken.zip'), 'this is not a zip file');
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip' }),
      { trash }
    );
    expect(result.filesErrored).toBeGreaterThan(0);
    expect(result.filesExtracted).toBe(0);
    expect(trashed).toEqual([]);
    expect(fs.existsSync(path.join(src, 'broken.zip'))).toBe(true);
  });
});

describe('path safety at run time', () => {
  it('refuses to run a recursive mapping whose destination is inside its source', async () => {
    writeFile(path.join(src, 'a.txt'));
    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: path.join(src, 'out'), recursive: true, actionType: 'copy' }),
      { trash }
    );
    expect(result.filesCopied).toBe(0);
    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/inside the source/);
    expect(listTree(src)).toEqual(['a.txt']);
  });

  it('refuses to run when source and destination are the same folder', async () => {
    writeFile(path.join(src, 'a.txt'));
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: src, actionType: 'move' }), { trash });
    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/same folder/);
  });
});
