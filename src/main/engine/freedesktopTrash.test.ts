import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFreedesktopTrash,
  decodeTrashPath,
  encodeTrashPath,
  formatDeletionDate,
  parseTrashInfo,
} from './freedesktopTrash';
import { makeTempDir, removeDir } from './testUtils';

let root: string;
let home: string;
let work: string;

beforeEach(() => {
  root = makeTempDir('fileshuttle-fdo-');
  home = path.join(root, 'home-trash');
  work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
});
afterEach(() => removeDir(root));

const window = () => ({ notBeforeMs: Date.now() - 60_000, notAfterMs: Date.now() + 60_000 });

describe('trash path encoding', () => {
  it('percent-encodes bytes and round-trips', () => {
    const p = '/srv/my files/ünï#100%.txt';
    const enc = encodeTrashPath(p);
    expect(enc).toBe('/srv/my%20files/%C3%BCn%C3%AF%23100%25.txt');
    expect(decodeTrashPath(enc)).toBe(p);
  });
  it('rejects a broken escape', () => {
    expect(decodeTrashPath('/a%zz')).toBeNull();
  });
  it('parses a trashinfo and ignores garbage', () => {
    const when = new Date(2026, 10, 27, 8, 5, 3);
    expect(formatDeletionDate(when)).toBe('2026-11-27T08:05:03');
    const parsed = parseTrashInfo('[Trash Info]\nPath=/a/b%20c\nDeletionDate=2026-11-27T08:05:03\n');
    expect(parsed?.path).toBe('/a/b c');
    expect(parsed?.deletionMs).toBe(when.getTime());
    expect(parseTrashInfo('nope')).toBeNull();
    expect(parseTrashInfo('[Trash Info]\nPath=/a\n')).toBeNull();
  });
});

describe('home trash (same device)', () => {
  it('moves a file into files/ with a trashinfo and never leaves a copy behind', async () => {
    const file = path.join(work, 'a b.txt');
    fs.writeFileSync(file, 'hello');
    const { trash } = createFreedesktopTrash({ homeTrashDir: home });
    await trash(file);

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'files', 'a b.txt'), 'utf8')).toBe('hello');
    const info = fs.readFileSync(path.join(home, 'info', 'a b.txt.trashinfo'), 'utf8');
    expect(info.startsWith('[Trash Info]\nPath=')).toBe(true);
    expect(info).toContain(`Path=${encodeTrashPath(file)}`);
    expect(info).toMatch(/DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it('gives a second file with the same name a unique name', async () => {
    const { trash } = createFreedesktopTrash({ homeTrashDir: home });
    for (const body of ['one', 'two', 'three']) {
      const file = path.join(work, 'same.txt');
      fs.writeFileSync(file, body);
      await trash(file);
    }
    expect(fs.readdirSync(path.join(home, 'files')).sort()).toEqual(['same.txt', 'same.txt.2', 'same.txt.3']);
    expect(fs.readdirSync(path.join(home, 'info')).length).toBe(3);
  });

  it('trashes a folder with its contents', async () => {
    const dir = path.join(work, 'folder');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'x');
    const { trash } = createFreedesktopTrash({ homeTrashDir: home });
    await trash(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'files', 'folder', 'sub', 'x.txt'), 'utf8')).toBe('x');
  });

  it('fails (and changes nothing) for a missing file', async () => {
    const { trash } = createFreedesktopTrash({ homeTrashDir: home });
    await expect(trash(path.join(work, 'missing.txt'))).rejects.toThrow();
  });

  it('fails the file, leaving it in place, when the trash cannot be written', async () => {
    const file = path.join(work, 'keep.txt');
    fs.writeFileSync(file, 'keep');
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'a file, not a folder');
    const { trash } = createFreedesktopTrash({ homeTrashDir: path.join(blocker, 'Trash') });
    await expect(trash(file)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  });
});

describe('another drive (per-mount trash)', () => {
  const mount = () => path.join(root, 'mount');

  function other(options: { uid?: number } = {}) {
    fs.mkdirSync(mount(), { recursive: true });
    return createFreedesktopTrash({
      homeTrashDir: home,
      uid: options.uid ?? 1234,
      sameDevice: async () => false,
      topdirOf: async () => mount(),
    });
  }

  it('uses $topdir/.Trash-$uid with a path relative to the mount', async () => {
    const file = path.join(mount(), 'docs', 'r.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'r');
    await other().trash(file);

    const trashDir = path.join(mount(), '.Trash-1234');
    expect(fs.readFileSync(path.join(trashDir, 'files', 'r.txt'), 'utf8')).toBe('r');
    expect(fs.readFileSync(path.join(trashDir, 'info', 'r.txt.trashinfo'), 'utf8')).toContain('Path=docs/r.txt\n');
    expect(fs.existsSync(path.join(home, 'files', 'r.txt'))).toBe(false);
  });

  it('uses $topdir/.Trash/$uid when .Trash is a sticky real folder', async () => {
    fs.mkdirSync(path.join(mount(), '.Trash'), { recursive: true });
    fs.chmodSync(path.join(mount(), '.Trash'), 0o1777);
    const file = path.join(mount(), 'r.txt');
    fs.writeFileSync(file, 'r');
    await other().trash(file);
    expect(fs.existsSync(path.join(mount(), '.Trash', '1234', 'files', 'r.txt'))).toBe(true);
  });

  it('ignores a .Trash that is not sticky', async () => {
    fs.mkdirSync(path.join(mount(), '.Trash'), { recursive: true });
    fs.chmodSync(path.join(mount(), '.Trash'), 0o755);
    const file = path.join(mount(), 'r.txt');
    fs.writeFileSync(file, 'r');
    await other().trash(file);
    expect(fs.existsSync(path.join(mount(), '.Trash-1234', 'files', 'r.txt'))).toBe(true);
  });

  it('fails the file, never deletes, when that drive has no writable trash', async () => {
    fs.mkdirSync(mount(), { recursive: true });
    fs.writeFileSync(path.join(mount(), '.Trash-1234'), 'a file in the way');
    const file = path.join(mount(), 'r.txt');
    fs.writeFileSync(file, 'r');
    await expect(other().trash(file)).rejects.toThrow(/trash folder/);
    expect(fs.readFileSync(file, 'utf8')).toBe('r');
  });

  it('restores from the per-mount trash', async () => {
    const file = path.join(mount(), 'docs', 'r.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'r');
    const t = other();
    await t.trash(file);
    const [result] = await t.restore([{ path: file, ...window() }]);
    expect(result.status).toBe('restored');
    expect(fs.readFileSync(file, 'utf8')).toBe('r');
    expect(fs.readdirSync(path.join(mount(), '.Trash-1234', 'info'))).toEqual([]);
  });
});

describe('restore (Undo of a delete)', () => {
  it('brings a file back and removes its trashinfo', async () => {
    const file = path.join(work, 'gone.txt');
    fs.writeFileSync(file, 'back');
    const t = createFreedesktopTrash({ homeTrashDir: home });
    await t.trash(file);
    const [result] = await t.restore([{ path: file, ...window() }]);
    expect(result).toEqual({ path: file, status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe('back');
    expect(fs.readdirSync(path.join(home, 'info'))).toEqual([]);
    expect(fs.readdirSync(path.join(home, 'files'))).toEqual([]);
  });

  it('restores a folder, and recreates a missing parent folder', async () => {
    const dir = path.join(work, 'parent', 'folder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    const t = createFreedesktopTrash({ homeTrashDir: home });
    await t.trash(dir);
    fs.rmdirSync(path.join(work, 'parent'));
    const [result] = await t.restore([{ path: dir, ...window() }]);
    expect(result.status).toBe('restored');
    expect(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8')).toBe('x');
  });

  it('never overwrites: something at the original place blocks the restore', async () => {
    const file = path.join(work, 'f.txt');
    fs.writeFileSync(file, 'old');
    const t = createFreedesktopTrash({ homeTrashDir: home });
    await t.trash(file);
    fs.writeFileSync(file, 'new');
    const [result] = await t.restore([{ path: file, ...window() }]);
    expect(result.status).toBe('blocked');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(home, 'files', 'f.txt'), 'utf8')).toBe('old');
  });

  it('picks the right copy when the same path was trashed twice', async () => {
    const file = path.join(work, 'same.txt');
    let t = 0;
    const clock = () => new Date(2026, 0, 1, 0, 0, (t += 5));
    const trash = createFreedesktopTrash({ homeTrashDir: home, now: clock });
    fs.writeFileSync(file, 'first');
    await trash.trash(file);
    fs.writeFileSync(file, 'second');
    await trash.trash(file);
    const [result] = await trash.restore([
      { path: file, notBeforeMs: 0, notAfterMs: Date.now() + 1e12 },
    ]);
    expect(result.status).toBe('restored');
    expect(fs.readFileSync(file, 'utf8')).toBe('second'); // the newest one
  });

  it('only restores items deleted inside the run window', async () => {
    const file = path.join(work, 'f.txt');
    fs.writeFileSync(file, 'x');
    const t = createFreedesktopTrash({ homeTrashDir: home });
    await t.trash(file);
    const [result] = await t.restore([{ path: file, notBeforeMs: 0, notAfterMs: 1000 }]);
    expect(result.status).toBe('not_found');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reports not_found for something that was never trashed or already emptied', async () => {
    const t = createFreedesktopTrash({ homeTrashDir: home });
    const [result] = await t.restore([{ path: path.join(work, 'nothing.txt'), ...window() }]);
    expect(result.status).toBe('not_found');
  });

  it('handles odd file names (spaces, percent, unicode)', async () => {
    const file = path.join(work, 'ünï 100%.txt');
    fs.writeFileSync(file, 'u');
    const t = createFreedesktopTrash({ homeTrashDir: home });
    await t.trash(file);
    const [result] = await t.restore([{ path: file, ...window() }]);
    expect(result.status).toBe('restored');
  });
});
