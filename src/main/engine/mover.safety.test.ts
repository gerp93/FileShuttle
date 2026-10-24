import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMapping } from './mover';
import { listTree, makeMapping, makeTempDir, removeDir, writeFile } from './testUtils';

let root: string;
let src: string;
let dest: string;
let trashed: string[];
const trash = async (p: string) => {
  trashed.push(p);
  fs.rmSync(p, { recursive: true, force: true });
};
const names = (paths: string[]) => paths.map((p) => path.relative(root, p).split(path.sep).join('/'));

beforeEach(() => {
  root = makeTempDir();
  src = path.join(root, 'src');
  dest = path.join(root, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  trashed = [];
});
afterEach(() => removeDir(root));

describe('unusable filters', () => {
  it('fails the mapping once, visibly, and touches nothing', async () => {
    writeFile(path.join(src, 'a.txt'));
    writeFile(path.join(src, 'b.txt'));
    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        filters: [{ field: 'filename_regex', operator: 'matches', value: '([unclosed', group: 0 }],
      }),
      { trash }
    );
    expect(result.fileOutcomes).toHaveLength(1);
    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/Filter 1 \(Filename \(regex\)\)/);
    expect(listTree(src)).toEqual(['a.txt', 'b.txt']);
    expect(listTree(dest)).toEqual([]);
  });

  it('catches a size written with units, which used to silently mean a few bytes', async () => {
    writeFile(path.join(src, 'a.txt'));
    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        actionType: 'delete',
        filters: [{ field: 'size', operator: 'min', value: '5MB', group: 0 }],
      }),
      { trash }
    );
    expect(result.filesErrored).toBe(1);
    expect(result.filesDeleted).toBe(0);
    expect(trashed).toEqual([]);
  });
});

describe('overwrite keeps the replaced file recoverable', () => {
  it('sends the existing destination file to the trash before replacing it', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' }), {
      trash,
    });
    expect(result.filesMoved).toBe(1);
    expect(names(trashed)).toEqual(['dest/a.txt']);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('NEW');
  });

  it('does not trash anything when nothing is being replaced', async () => {
    writeFile(path.join(src, 'a.txt'));
    await runMapping(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' }), { trash });
    expect(trashed).toEqual([]);
  });

  it('overwrites without a backup when the option is off', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    await runMapping(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' }), {
      trash,
      backupOverwritten: false,
    });
    expect(trashed).toEqual([]);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('NEW');
  });

  it('leaves both files alone and reports an error when the trash cannot take the old one', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    const result = await runMapping(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' }), {
      trash: async () => {
        throw new Error('no recycle bin on network drives');
      },
    });
    expect(result.filesErrored).toBe(1);
    expect(result.filesMoved).toBe(0);
    expect(result.fileOutcomes[0].reason).toMatch(/Not replaced.*no recycle bin on network drives/);
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(src, 'a.txt'), 'utf8')).toBe('NEW');
  });

  it('applies to copy and zip as well', async () => {
    writeFile(path.join(src, 'a.txt'), 'NEW');
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    await runMapping(makeMapping({ sourcePath: src, destPath: dest, actionType: 'copy', conflictPolicy: 'overwrite' }), {
      trash,
    });
    expect(names(trashed)).toEqual(['dest/a.txt']);

    trashed = [];
    writeFile(path.join(dest, 'a.txt.zip'), 'OLD ZIP');
    await runMapping(makeMapping({ sourcePath: src, destPath: dest, actionType: 'zip', conflictPolicy: 'overwrite' }), {
      trash,
    });
    expect(names(trashed)).toEqual(['dest/a.txt.zip']);
  });

  it('unzip: trashes only the files the archive replaces and keeps the others', async () => {
    const zip = new AdmZip();
    zip.addFile('one.txt', Buffer.from('NEW'));
    zip.addFile('fresh.txt', Buffer.from('FRESH'));
    zip.writeZip(path.join(src, 'bundle.zip'));
    writeFile(path.join(dest, 'bundle', 'one.txt'), 'OLD');
    writeFile(path.join(dest, 'bundle', 'keep.txt'), 'KEEP');

    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip', conflictPolicy: 'overwrite' }),
      { trash }
    );

    expect(result.filesExtracted).toBe(1);
    expect(names(trashed)).toEqual(['dest/bundle/one.txt', 'src/bundle.zip']);
    expect(listTree(path.join(dest, 'bundle'))).toEqual(['fresh.txt', 'keep.txt', 'one.txt']);
    expect(fs.readFileSync(path.join(dest, 'bundle', 'one.txt'), 'utf8')).toBe('NEW');
    expect(fs.readFileSync(path.join(dest, 'bundle', 'keep.txt'), 'utf8')).toBe('KEEP');
  });

  it('unzip: does not extract, and keeps the archive, when a replaced file cannot be backed up', async () => {
    const zip = new AdmZip();
    zip.addFile('one.txt', Buffer.from('NEW'));
    zip.writeZip(path.join(src, 'bundle.zip'));
    writeFile(path.join(dest, 'bundle', 'one.txt'), 'OLD');

    const result = await runMapping(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip', conflictPolicy: 'overwrite' }),
      {
        trash: async () => {
          throw new Error('nope');
        },
      }
    );

    expect(result.filesErrored).toBe(1);
    expect(result.filesExtracted).toBe(0);
    expect(fs.readFileSync(path.join(dest, 'bundle', 'one.txt'), 'utf8')).toBe('OLD');
    expect(fs.existsSync(path.join(src, 'bundle.zip'))).toBe(true);
  });
});
