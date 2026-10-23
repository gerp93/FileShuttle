import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunResult } from '../../shared/types';
import { runMapping } from './mover';
import { RestoreRequest, RestoreResult } from './recycleBin';
import { listTree, makeMapping, makeTempDir, removeDir, writeFile } from './testUtils';
import { undoRun } from './undo';

/** An in-memory stand-in for the Recycle Bin: trash moves files aside, restore moves them back. */
class FakeBin {
  items: { original: string; stored: string; at: number }[] = [];
  private counter = 0;
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  trash = async (p: string): Promise<void> => {
    const stored = path.join(this.dir, `item-${this.counter++}`);
    fs.renameSync(p, stored);
    this.items.push({ original: p, stored, at: Date.now() });
  };

  restore = async (requests: RestoreRequest[]): Promise<RestoreResult[]> =>
    requests.map((r) => {
      if (fs.existsSync(r.path)) return { path: r.path, status: 'blocked' as const };
      const match = this.items
        .filter((i) => i.original.toLowerCase() === r.path.toLowerCase() && i.at >= r.notBeforeMs && i.at <= r.notAfterMs)
        .sort((a, b) => b.at - a.at)[0];
      if (!match) return { path: r.path, status: 'not_found' as const };
      fs.mkdirSync(path.dirname(r.path), { recursive: true });
      fs.renameSync(match.stored, r.path);
      this.items = this.items.filter((i) => i !== match);
      return { path: r.path, status: 'restored' as const };
    });
}

let root: string;
let src: string;
let dest: string;
let bin: FakeBin;

beforeEach(() => {
  root = makeTempDir();
  src = path.join(root, 'src');
  dest = path.join(root, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  bin = new FakeBin(path.join(root, '.bin'));
});
afterEach(() => removeDir(root));

const run = (mapping: Parameters<typeof makeMapping>[0]) =>
  runMapping(makeMapping(mapping), { trash: bin.trash });
const undo = (result: RunResult, extra: { originalWasUndo?: boolean } = {}) =>
  undoRun(result.fileOutcomes, {
    trash: bin.trash,
    restore: bin.restore,
    window: { startedAt: result.startedAt, finishedAt: result.finishedAt },
    ...extra,
  });
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

describe('undo of a move', () => {
  it('moves files back to where they came from', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    const result = await run({ sourcePath: src, destPath: dest });
    expect(listTree(src)).toEqual([]);

    const undone = await undo(result);
    expect(undone.filesMoved).toBe(1);
    expect(listTree(src)).toEqual(['a.txt']);
    expect(listTree(dest)).toEqual([]);
  });

  it('refuses to clobber a file that has since reappeared at the source', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    const result = await run({ sourcePath: src, destPath: dest });
    writeFile(path.join(src, 'a.txt'), 'NEWER');

    const undone = await undo(result);
    expect(undone.filesSkipped).toBe(1);
    expect(read(src, 'a.txt')).toBe('NEWER');
    expect(listTree(dest)).toEqual(['a.txt']);
  });

  it('reports an error when the moved file is gone', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    const result = await run({ sourcePath: src, destPath: dest });
    fs.rmSync(path.join(dest, 'a.txt'));
    expect((await undo(result)).filesErrored).toBe(1);
  });

  it('also brings back a file the move had replaced', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    const result = await run({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' });
    expect(read(dest, 'a.txt')).toBe('NEW');

    await undo(result);

    expect(read(src, 'a.txt')).toBe('NEW');
    expect(read(dest, 'a.txt')).toBe('OLD');
  });
});

describe('undo of a copy', () => {
  it('removes the copies and leaves the originals alone', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'copy' });
    expect(listTree(dest)).toEqual(['a.txt']);

    const undone = await undo(result);

    expect(undone.filesDeleted).toBe(1);
    expect(listTree(dest)).toEqual([]);
    expect(listTree(src)).toEqual(['a.txt']);
  });

  it('restores the file the copy had replaced', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'copy', conflictPolicy: 'overwrite' });
    expect(read(dest, 'a.txt')).toBe('NEW');

    await undo(result);

    expect(read(dest, 'a.txt')).toBe('OLD');
    expect(read(src, 'a.txt')).toBe('NEW');
  });

  it('does not restore an unrelated older file deleted outside the run window', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'copy', conflictPolicy: 'overwrite' });
    // Same path, binned long before this run: must not be mistaken for something this run replaced.
    const stale = path.join(root, '.bin', 'stale');
    fs.writeFileSync(stale, 'STALE');
    bin.items.push({ original: path.join(dest, 'a.txt'), stored: stale, at: Date.now() - 24 * 60 * 60 * 1000 });

    await undo(result);

    expect(listTree(dest)).toEqual([]);
  });
});

describe('undo of a zip', () => {
  it('removes the archives that were created', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'zip' });
    expect(listTree(dest)).toEqual(['a.txt.zip']);

    await undo(result);

    expect(listTree(dest)).toEqual([]);
    expect(listTree(src)).toEqual(['a.txt']);
  });
});

describe('undo of a delete', () => {
  it('restores the deleted files from the bin', async () => {
    writeFile(path.join(src, 'a.tmp'), 'A');
    writeFile(path.join(src, 'b.tmp'), 'B');
    const result = await run({ sourcePath: src, actionType: 'delete' });
    expect(listTree(src)).toEqual([]);

    const undone = await undo(result);

    expect(undone.filesMoved).toBe(2);
    expect(listTree(src)).toEqual(['a.tmp', 'b.tmp']);
    expect(read(src, 'a.tmp')).toBe('A');
  });

  it('reports files that are no longer in the bin', async () => {
    writeFile(path.join(src, 'a.tmp'), 'A');
    const result = await run({ sourcePath: src, actionType: 'delete' });
    bin.items = []; // bin emptied

    const undone = await undo(result);

    expect(undone.filesErrored).toBe(1);
    expect(undone.fileOutcomes[0].reason).toMatch(/no longer in the Recycle Bin/);
  });

  it('does not overwrite a file that now exists at the original path', async () => {
    writeFile(path.join(src, 'a.tmp'), 'ORIGINAL');
    const result = await run({ sourcePath: src, actionType: 'delete' });
    writeFile(path.join(src, 'a.tmp'), 'RECREATED');

    const undone = await undo(result);

    expect(undone.filesSkipped).toBe(1);
    expect(read(src, 'a.tmp')).toBe('RECREATED');
  });
});

describe('undo of an unzip', () => {
  const makeZip = (zipPath: string, files: Record<string, string>) => {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
    zip.writeZip(zipPath);
  };

  it('restores the original zip and removes the extracted folder', async () => {
    makeZip(path.join(src, 'bundle.zip'), { 'one.txt': '1' });
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'unzip' });
    expect(listTree(dest)).toEqual(['bundle/one.txt']);
    expect(listTree(src)).toEqual([]);

    await undo(result);

    expect(listTree(src)).toEqual(['bundle.zip']);
    expect(listTree(dest)).toEqual([]);
  });

  it('keeps the extracted folder when the zip cannot be restored', async () => {
    makeZip(path.join(src, 'bundle.zip'), { 'one.txt': '1' });
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'unzip' });
    bin.items = []; // bin emptied: the zip is gone for good

    const undone = await undo(result);

    expect(undone.filesErrored).toBe(1);
    expect(undone.fileOutcomes[0].reason).toMatch(/kept the extracted folder/);
    expect(listTree(dest)).toEqual(['bundle/one.txt']);
  });

  it('will not remove a folder it merged into, since the user’s own files may be in it', async () => {
    makeZip(path.join(src, 'bundle.zip'), { 'one.txt': 'NEW' });
    writeFile(path.join(dest, 'bundle', 'mine.txt'), 'MINE');
    const result = await run({ sourcePath: src, destPath: dest, actionType: 'unzip', conflictPolicy: 'overwrite' });

    const undone = await undo(result);

    expect(undone.filesSkipped).toBe(1);
    expect(undone.fileOutcomes[0].reason).toMatch(/not undone/);
    expect(read(dest, 'bundle', 'mine.txt')).toBe('MINE');
  });
});

describe('undoing an undo', () => {
  it('only reverses moves', async () => {
    writeFile(path.join(src, 'a.txt'), 'A');
    const first = await run({ sourcePath: src, destPath: dest });
    const undone = await undo(first);
    expect(listTree(src)).toEqual(['a.txt']);

    const redone = await undo(undone, { originalWasUndo: true });

    expect(redone.filesMoved).toBe(1);
    expect(listTree(dest)).toEqual(['a.txt']);
  });
});
