import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { AllowedFolders, isInside } from './allowedFolders';

let root: string;
let allowed: string;
let outside: string;
beforeEach(() => {
  root = fs.realpathSync(makeTempDir('fileshuttle-allowed-'));
  allowed = path.join(root, 'allowed');
  outside = path.join(root, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
});
afterEach(() => removeDir(root));

// Symlinks need privileges on Windows; everything else here is path logic that runs everywhere.
const linuxOnly = it.skipIf(process.platform === 'win32');

describe('isInside', () => {
  it('compares paths by their parts, not as strings', () => {
    expect(isInside(path.join(allowed, 'a', 'b'), allowed)).toBe(true);
    expect(isInside(allowed, allowed)).toBe(true);
    expect(isInside(`${allowed}-sibling`, allowed)).toBe(false);
    expect(isInside(path.join(allowed, '..', 'outside'), allowed)).toBe(false);
    expect(isInside(root, allowed)).toBe(false);
  });

  it('ignores case on Windows only', () => {
    if (process.platform === 'win32') expect(isInside('C:\\Data\\Sub', 'c:\\data')).toBe(true);
    else expect(isInside('/Data/Sub', '/data')).toBe(false);
  });
});

describe('AllowedFolders', () => {
  it('allows the folders and what is below them, even where nothing exists yet', async () => {
    const guard = new AllowedFolders([allowed]);
    expect(await guard.problemWith(allowed)).toBeNull();
    expect(await guard.problemWith(path.join(allowed, 'new', 'deeper'))).toBeNull();
    expect(await guard.problemWith(outside)).toMatch(/outside the folders this machine allows/);
    expect(await guard.problemWith(`${allowed}-sibling`)).toMatch(/outside/);
  });

  it('refuses everything when the list is empty, and says how to fix it', async () => {
    const guard = new AllowedFolders([]);
    expect(guard.isEmpty).toBe(true);
    expect(await guard.problemWith(allowed)).toMatch(/no allowed folders/);
    expect(await guard.checkOrRefuse(allowed)).toMatchObject({ status: 'invalid', message: expect.stringContaining('FILESHUTTLE_WORKER_ALLOWED_FOLDERS') });
    expect((await guard.limitListing(null, async () => { throw new Error('unused'); })).error).toMatch(/no allowed folders/);
  });

  it('refuses relative paths and “..” segments instead of guessing', async () => {
    const guard = new AllowedFolders([allowed]);
    expect(await guard.problemWith('relative/dir')).toMatch(/not a full path/);
    expect(await guard.problemWith(`${allowed}${path.sep}..${path.sep}outside`)).toMatch(/\.\./);
  });

  it('ignores relative roots in its own list', () => {
    expect(new AllowedFolders(['relative', '']).isEmpty).toBe(true);
  });

  linuxOnly('refuses a symlink inside an allowed folder that points out of it', async () => {
    fs.symlinkSync(outside, path.join(allowed, 'link'));
    const guard = new AllowedFolders([allowed]);
    expect(await guard.problemWith(path.join(allowed, 'link'))).toMatch(/outside/);
    expect(await guard.problemWith(path.join(allowed, 'link', 'file.txt'))).toMatch(/outside/);
    expect(await guard.problemWith(path.join(allowed, 'link', 'not', 'there'))).toMatch(/outside/);
  });

  linuxOnly('follows an allowed folder that is itself a link', async () => {
    const link = path.join(root, 'shortcut');
    fs.symlinkSync(allowed, link);
    expect(await new AllowedFolders([link]).problemWith(path.join(allowed, 'x'))).toBeNull();
    expect(await new AllowedFolders([allowed]).problemWith(path.join(link, 'x'))).toBeNull();
  });

  it('checks both folders of a mapping, but not the destination of a delete', async () => {
    const guard = new AllowedFolders([allowed]);
    const base = { sourcePath: path.join(allowed, 'in'), destPath: outside, actionType: 'move' as const };
    expect(await guard.problemWithMapping(base)).toMatch(/outside/);
    expect(await guard.problemWithMapping({ ...base, actionType: 'delete' })).toBeNull();
    expect(await guard.problemWithMapping({ ...base, sourcePath: outside, destPath: allowed })).toMatch(/outside/);
    expect(await guard.problemWithMapping({ ...base, destPath: path.join(allowed, 'out') })).toBeNull();
  });

  it('refuses a whole undo when any path it would touch is outside', async () => {
    const guard = new AllowedFolders([allowed]);
    const outcome = (s: string, d: string | null) => ({ sourcePath: s, destPath: d, outcome: 'moved' as const, reason: null, sizeBytes: 1 });
    expect(await guard.problemWithOutcomes([outcome(path.join(allowed, 'a'), path.join(allowed, 'b'))])).toBeNull();
    expect(
      await guard.problemWithOutcomes([outcome(path.join(allowed, 'a'), path.join(allowed, 'b')), outcome(path.join(allowed, 'c'), path.join(outside, 'd'))])
    ).toMatch(/outside/);
  });

  it('lists only the allowed folders to start with, and never offers a way up out of them', async () => {
    writeFile(path.join(allowed, 'sub', 'f.txt'), 'x');
    const guard = new AllowedFolders([allowed]);
    const start = await guard.limitListing(null, async () => { throw new Error('unused'); });
    expect(start.folders).toEqual([{ name: allowed, path: allowed }]);
    const inside = await guard.limitListing(allowed, async (p) => ({ path: p, parent: path.dirname(allowed), folders: [], truncated: false }));
    expect(inside.parent).toBeNull();
    const deeper = await guard.limitListing(path.join(allowed, 'sub'), async (p) => ({ path: p, parent: allowed, folders: [], truncated: false }));
    expect(deeper.parent).toBe(allowed);
    const refused = await guard.limitListing(outside, async () => { throw new Error('must not list'); });
    expect(refused.error).toMatch(/outside/);
  });
});
