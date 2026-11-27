import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFolder } from './folderBrowse';
import { makeTempDir, removeDir, writeFile } from './engine/testUtils';

let root: string;
beforeEach(() => {
  root = makeTempDir('fileshuttle-browse-');
});
afterEach(() => removeDir(root));

describe('listFolder', () => {
  it('returns only visible subfolders, sorted', async () => {
    fs.mkdirSync(path.join(root, 'beta'));
    fs.mkdirSync(path.join(root, 'Alpha'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.mkdirSync(path.join(root, '$Recycle.Bin'));
    writeFile(path.join(root, 'file.txt'), 'x');

    const result = await listFolder(root);
    expect(result.error).toBeUndefined();
    expect(result.folders.map((f) => f.name)).toEqual(['Alpha', 'beta']);
    expect(result.folders[0].path).toBe(path.join(root, 'Alpha'));
    expect(result.path).toBe(path.resolve(root));
    expect(result.parent).toBe(path.dirname(path.resolve(root)));
    expect(result.truncated).toBe(false);
  });

  it('reports a missing folder as a message, with a way back up', async () => {
    const missing = path.join(root, 'nope', 'deeper');
    const result = await listFolder(missing);
    expect(result.error).toBeTruthy();
    expect(result.folders).toEqual([]);
    expect(result.parent).toBe(path.join(root, 'nope'));
  });

  it('reports a file, and a relative path, as messages', async () => {
    writeFile(path.join(root, 'a.txt'), 'x');
    expect((await listFolder(path.join(root, 'a.txt'))).error).toMatch(/file/);
    expect((await listFolder('relative/path')).error).toMatch(/full path/);
  });

  it('lists the roots when no path is given', async () => {
    const result = await listFolder();
    expect(result.path).toBeNull();
    expect(result.parent).toBeNull();
    expect(result.folders.length).toBeGreaterThan(0);
    expect((await listFolder('   ')).path).toBeNull();
  });
});
