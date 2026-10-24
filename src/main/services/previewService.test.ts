import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_OUTCOME_LIMIT } from '../../shared/types';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeMapping, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { inputToConfig, previewJob, previewMapping } from './previewService';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-preview-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
});
afterEach(() => {
  db.close();
  removeDir(root);
});

describe('previewMapping', () => {
  it('summarises what would happen with the total size, and changes nothing', async () => {
    const src = path.join(root, 'src');
    writeFile(path.join(src, 'a.txt'), '12345');
    writeFile(path.join(src, 'b.txt'), '123');
    const preview = await previewMapping(
      makeMapping({ id: 7, name: 'm', sourcePath: src, destPath: path.join(root, 'dest') })
    );

    expect(preview.mappingId).toBe(7);
    expect(preview.result.filesMoved).toBe(2);
    expect(preview.totalBytes).toBe(8);
    expect(preview.truncated).toBe(false);
    expect(listTree(src)).toEqual(['a.txt', 'b.txt']);
    expect(listTree(path.join(root, 'dest'))).toEqual([]);
  });

  it('does not count skipped files toward the size', async () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'a.txt'), '12345');
    writeFile(path.join(dest, 'a.txt'), 'x');
    const preview = await previewMapping(makeMapping({ sourcePath: src, destPath: dest }));
    expect(preview.result.filesSkipped).toBe(1);
    expect(preview.totalBytes).toBe(0);
  });

  it('counts how many files would replace an existing one', async () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'a.txt'), 'new');
    writeFile(path.join(src, 'b.txt'), 'new');
    writeFile(path.join(dest, 'a.txt'), 'old');
    const preview = await previewMapping(makeMapping({ sourcePath: src, destPath: dest, conflictPolicy: 'overwrite' }));
    expect(preview.overwriteCount).toBe(1);
    expect(preview.result.filesMoved).toBe(2);
  });

  it('caps the per-file rows but keeps counts and size for every file', async () => {
    const src = path.join(root, 'src');
    const total = PREVIEW_OUTCOME_LIMIT + 25;
    for (let i = 0; i < total; i += 1) writeFile(path.join(src, `f${i}.txt`), 'x');

    const preview = await previewMapping(makeMapping({ sourcePath: src, destPath: path.join(root, 'dest') }));

    expect(preview.truncated).toBe(true);
    expect(preview.totalOutcomes).toBe(total);
    expect(preview.result.fileOutcomes).toHaveLength(PREVIEW_OUTCOME_LIMIT);
    expect(preview.result.filesMoved).toBe(total);
    expect(preview.totalBytes).toBe(total);
  });

  it('turns unsaved editor input into a runnable config', () => {
    const config = inputToConfig({
      name: 'draft',
      sourcePath: 'C:\\in',
      destPath: 'C:\\out',
      recursive: true,
      conflictPolicy: 'overwrite',
      enabled: true,
      scheduleType: 'manual',
      scheduleIntervalMinutes: null,
      scheduleDailyTime: null,
      filters: [],
      filterMatchMode: 'any',
      nextMappingId: null,
      actionType: 'copy',
      keepNewest: 3,
    });
    expect(config).toMatchObject({ id: 0, name: 'draft', actionType: 'copy', keepNewest: 3, filterMatchMode: 'any' });
  });
});

describe('previewJob', () => {
  const addMapping = (name: string, source: string, dest: string, enabled = true) =>
    repo.createMapping(db, {
      name,
      sourcePath: source,
      destPath: dest,
      recursive: false,
      conflictPolicy: 'skip',
      enabled,
      scheduleType: 'manual',
      scheduleIntervalMinutes: null,
      scheduleDailyTime: null,
      filters: [],
      filterMatchMode: 'all',
      nextMappingId: null,
      actionType: 'move',
      keepNewest: null,
    });

  it('previews each enabled step, skips disabled ones, and records no history', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'f.txt'));
    const jobId = repo.createJob(db, {
      name: 'job',
      enabled: true,
      scheduleType: 'manual',
      scheduleIntervalMinutes: null,
      scheduleDailyTimes: [],
      mappingIds: [addMapping('first', a, path.join(root, 'b')), addMapping('off', a, path.join(root, 'x'), false)],
    });

    const preview = await previewJob(db, jobId);

    expect(preview.jobName).toBe('job');
    expect(preview.steps.map((s) => s.mappingName)).toEqual(['first']);
    expect(preview.steps[0].result.filesMoved).toBe(1);
    expect(listTree(a)).toEqual(['f.txt']);
    expect(repo.listRuns(db)).toHaveLength(0);
  });

  it('rejects an unknown job', async () => {
    await expect(previewJob(db, 12345)).rejects.toThrow(/No job/);
  });
});
