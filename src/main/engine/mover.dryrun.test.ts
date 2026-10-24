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

beforeEach(() => {
  root = makeTempDir();
  src = path.join(root, 'src');
  dest = path.join(root, 'dest');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  trashed = [];
});
afterEach(() => removeDir(root));

const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rel of listTree(dir)) out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
  return out;
};

const makeZip = (zipPath: string, files: Record<string, string>) => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  zip.writeZip(zipPath);
};

/**
 * Dry-runs a mapping and checks nothing changed, then really runs it. The
 * outcome lists (paths, outcomes, reasons) must be identical -- that is the
 * whole promise of "preview".
 */
async function previewThenRun(mapping: ReturnType<typeof makeMapping>) {
  const before = { src: snapshot(src), dest: snapshot(dest) };
  const preview = await runMapping(mapping, { trash, dryRun: true });
  expect(snapshot(src)).toEqual(before.src);
  expect(snapshot(dest)).toEqual(before.dest);
  expect(trashed).toEqual([]);

  const real = await runMapping(mapping, { trash });
  expect(preview.fileOutcomes).toEqual(real.fileOutcomes);
  return { preview, real };
}

describe('dry run', () => {
  it('creates no destination folder for a move', async () => {
    writeFile(path.join(src, 'a.txt'));
    const newDest = path.join(root, 'does-not-exist-yet');
    await runMapping(makeMapping({ sourcePath: src, destPath: newDest }), { trash, dryRun: true });
    expect(fs.existsSync(newDest)).toBe(false);
    expect(listTree(src)).toEqual(['a.txt']);
  });

  it('matches a real move run, including recursion and filters', async () => {
    writeFile(path.join(src, 'a.txt'));
    writeFile(path.join(src, 'b.log'));
    writeFile(path.join(src, 'sub', 'c.txt'));
    const { preview } = await previewThenRun(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        recursive: true,
        filters: [{ field: 'extension', operator: 'equals', value: 'txt', group: 0 }],
      })
    );
    expect(preview.filesMoved).toBe(2);
  });

  it.each(['skip', 'overwrite', 'auto_rename'] as const)(
    'matches a real run with the %s conflict policy',
    async (policy) => {
      writeFile(path.join(src, 'a.txt'), 'NEW');
      writeFile(path.join(src, 'b.txt'), 'NEW');
      writeFile(path.join(dest, 'a.txt'), 'OLD');
      writeFile(path.join(dest, 'a (1).txt'), 'OLD1');
      await previewThenRun(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: policy }));
    }
  );

  it('matches a real copy run', async () => {
    writeFile(path.join(src, 'a.txt'));
    writeFile(path.join(dest, 'a.txt'), 'OLD');
    await previewThenRun(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'copy', conflictPolicy: 'auto_rename' })
    );
  });

  it('matches a real keep-newest run', async () => {
    writeFile(path.join(src, 'old.txt'), 'o', new Date('2020-01-01'));
    writeFile(path.join(src, 'new.txt'), 'n', new Date('2022-01-01'));
    await previewThenRun(makeMapping({ sourcePath: src, destPath: dest, keepNewest: 1 }));
  });

  it('matches a real delete run, trashing nothing while previewing', async () => {
    writeFile(path.join(src, 'a.tmp'));
    writeFile(path.join(src, 'b.tmp'));
    const { real } = await previewThenRun(makeMapping({ sourcePath: src, actionType: 'delete' }));
    expect(real.filesDeleted).toBe(2);
    expect(trashed).toHaveLength(2);
  });

  it('matches a real zip run, including an existing archive', async () => {
    writeFile(path.join(src, 'a.txt'));
    writeFile(path.join(src, 'folder', 'inner.txt'));
    writeFile(path.join(dest, 'a.txt.zip'), 'EXISTING');
    await previewThenRun(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'zip', conflictPolicy: 'auto_rename' })
    );
  });

  it('matches a real unzip run and leaves the zip alone while previewing', async () => {
    makeZip(path.join(src, 'bundle.zip'), { 'one.txt': '1' });
    fs.mkdirSync(path.join(dest, 'bundle'));
    await previewThenRun(
      makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip', conflictPolicy: 'auto_rename' })
    );
    expect(listTree(dest)).toContain('bundle (1)/one.txt');
  });

  it('reports a corrupt archive as an error in the preview, before a real run', async () => {
    writeFile(path.join(src, 'broken.zip'), 'not a zip');
    const preview = await runMapping(makeMapping({ sourcePath: src, destPath: dest, actionType: 'unzip' }), {
      trash,
      dryRun: true,
    });
    expect(preview.filesErrored).toBe(1);
    expect(preview.filesExtracted).toBe(0);
  });
});
