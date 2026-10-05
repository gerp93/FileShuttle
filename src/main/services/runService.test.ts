import * as fs from 'fs';
import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../database/repository';
import { initDatabase, saveDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { executeAllEnabledJobs, executeJob, JobAlreadyRunningError } from './runService';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));
vi.mock('../database/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database/schema')>();
  return { ...actual, saveDatabase: vi.fn(actual.saveDatabase) };
});

let root: string;
let db: Database;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-run-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  vi.mocked(saveDatabase).mockClear();
});
afterEach(() => {
  db.close();
  removeDir(root);
});

function addMapping(name: string, src: string, dest: string, extra: Partial<Parameters<typeof repo.createMapping>[1]> = {}) {
  return repo.createMapping(db, {
    name,
    sourcePath: src,
    destPath: dest,
    recursive: false,
    conflictPolicy: 'skip',
    enabled: true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    filters: [],
    filterMatchMode: 'all',
    nextMappingId: null,
    actionType: 'move',
    keepNewest: null,
    ...extra,
  });
}

function addJob(name: string, mappingIds: number[]) {
  return repo.createJob(db, {
    name,
    enabled: true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    mappingIds,
  });
}

describe('executeJob', () => {
  it('runs each step in order and records a history row per step', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    const c = path.join(root, 'c');
    writeFile(path.join(a, 'file.txt'));
    const jobId = addJob('chain', [addMapping('a-to-b', a, b), addMapping('b-to-c', b, c)]);

    const result = await executeJob(db, jobId, 'manual');

    expect(result.filesMoved).toBe(2);
    expect(listTree(c)).toEqual(['file.txt']);
    const runs = repo.listRuns(db, { jobId });
    expect(runs).toHaveLength(2);
  });

  it('saves the database after every step, not just at the end', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'file.txt'));
    const jobId = addJob('two-steps', [
      addMapping('one', a, path.join(root, 'b')),
      addMapping('two', path.join(root, 'b'), path.join(root, 'c')),
    ]);

    await executeJob(db, jobId, 'manual');

    expect(vi.mocked(saveDatabase)).toHaveBeenCalledTimes(2);
  });

  it('skips disabled steps', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'file.txt'));
    const mappingId = addMapping('off', a, path.join(root, 'b'), { enabled: false });
    const jobId = addJob('j', [mappingId]);

    const result = await executeJob(db, jobId, 'manual');
    expect(result.fileOutcomes).toEqual([]);
    expect(listTree(a)).toEqual(['file.txt']);
  });

  it('records a mapping with unsafe folders as a failed run instead of running it', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'file.txt'));
    const jobId = addJob('unsafe', [addMapping('self-feeding', a, path.join(a, 'out'), { recursive: true })]);

    const result = await executeJob(db, jobId, 'manual');

    expect(result.filesErrored).toBe(1);
    expect(result.fileOutcomes[0].reason).toMatch(/inside the source/);
    expect(listTree(a)).toEqual(['file.txt']);
  });

  it('rejects an unknown job', async () => {
    await expect(executeJob(db, 9999, 'manual')).rejects.toThrow(/No job/);
  });
});

describe('run lock', () => {
  it('rejects a second run of the same job while the first is in flight', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'file.txt'));
    const jobId = addJob('busy', [addMapping('m', a, path.join(root, 'b'))]);

    const first = executeJob(db, jobId, 'manual');
    await expect(executeJob(db, jobId, 'scheduled')).rejects.toBeInstanceOf(JobAlreadyRunningError);
    await first;

    // Once the first run is done, the job can run again.
    await expect(executeJob(db, jobId, 'manual')).resolves.toBeDefined();
  });

  it('releases the lock even when a run fails', async () => {
    const jobId = addJob('bad', []);
    repo.deleteJob(db, jobId);
    await expect(executeJob(db, jobId, 'manual')).rejects.toThrow(/No job/);
    // Not stuck "already running":
    await expect(executeJob(db, jobId, 'manual')).rejects.toThrow(/No job/);
  });

  it('lets different jobs run, one after another', async () => {
    const jobs: number[] = [];
    for (const name of ['x', 'y']) {
      const src = path.join(root, name);
      writeFile(path.join(src, `${name}.txt`));
      jobs.push(addJob(name, [addMapping(name, src, path.join(root, `${name}-out`))]));
    }
    const results = await Promise.all(jobs.map((id) => executeJob(db, id, 'manual')));
    expect(results.map((r) => r.filesMoved)).toEqual([1, 1]);
  });

  it('runAll skips a job that is already running rather than failing', async () => {
    const a = path.join(root, 'a');
    writeFile(path.join(a, 'file.txt'));
    const busyId = addJob('busy', [addMapping('m', a, path.join(root, 'b'))]);
    const otherSrc = path.join(root, 'o');
    writeFile(path.join(otherSrc, 'o.txt'));
    addJob('other', [addMapping('om', otherSrc, path.join(root, 'o-out'))]);

    const first = executeJob(db, busyId, 'manual');
    const results = await executeAllEnabledJobs(db, 'manual');
    await first;

    expect(results).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'o-out', 'o.txt'))).toBe(true);
  });
});
