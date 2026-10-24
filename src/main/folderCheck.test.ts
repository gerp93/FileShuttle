import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFolder, nearestExistingFolder } from './folderCheck';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshuttle-folder-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkFolder', () => {
  it('accepts an existing folder for either role', async () => {
    expect((await checkFolder(root, 'source')).status).toBe('ok');
    expect((await checkFolder(root, 'destination')).status).toBe('ok');
  });

  it('ignores the quotes Explorer adds when copying a path', async () => {
    expect((await checkFolder(`"${root}"`, 'source')).status).toBe('ok');
  });

  it('has nothing to say about an empty field', async () => {
    expect(await checkFolder('   ', 'source')).toEqual({ status: 'ok', message: null });
  });

  it('warns that a missing source folder is not there', async () => {
    expect((await checkFolder(path.join(root, 'nope'), 'source')).status).toBe('missing');
  });

  it('lets a destination be created when a folder above it exists', async () => {
    expect((await checkFolder(path.join(root, 'a', 'b'), 'destination')).status).toBe('will_create');
  });

  it('refuses a file in place of a folder', async () => {
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    expect((await checkFolder(file, 'source')).status).toBe('not_folder');
    expect((await checkFolder(file, 'destination')).status).toBe('not_folder');
  });

  it('refuses a relative path', async () => {
    expect((await checkFolder('some/folder', 'source')).status).toBe('invalid');
  });

  it.runIf(process.platform === 'win32')('refuses characters Windows does not allow in names', async () => {
    expect((await checkFolder(path.join(root, 'a|b'), 'destination')).status).toBe('invalid');
  });
});

describe('nearestExistingFolder', () => {
  it('returns the folder itself when it exists', async () => {
    expect(await nearestExistingFolder(root)).toBe(path.resolve(root));
  });

  it('walks up to the closest folder that exists', async () => {
    expect(await nearestExistingFolder(path.join(root, 'x', 'y'))).toBe(path.resolve(root));
  });

  it('gives up when a file is in the way', async () => {
    const file = path.join(root, 'f.txt');
    fs.writeFileSync(file, 'x');
    expect(await nearestExistingFolder(path.join(file, 'inside'))).toBeNull();
  });
});
