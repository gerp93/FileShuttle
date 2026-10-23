import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunProgressEvent } from '../../shared/types';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { cancelJob, executeJob, getActiveRuns, isJobActive, setRunProgressListener } from './runService';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;
let events: RunProgressEvent[];

beforeEach(async () => {
  root = makeTempDir('fileshuttle-progress-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  events = [];
  setRunProgressListener((e) => events.push(e));
});
afterEach(() => {
  setRunProgressListener(null);
  db.close();
  removeDir(root);
});

function addJobWithFiles(name: string, fileCount: number, steps = 1): number {
  const mappingIds: number[] = [];
  let from = path.join(root, `${name}-0`);
  for (let i = 0; i < fileCount; i += 1) writeFile(path.join(from, `f${i}.txt`));
  for (let step = 0; step < steps; step += 1) {
    const to = path.join(root, `${name}-${step + 1}`);
    mappingIds.push(
      repo.createMapping(db, {
        name: `${name} step ${step + 1}`,
        sourcePath: from,
        destPath: to,
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
      })
    );
    from = to;
  }
  return repo.createJob(db, {
    name,
    enabled: true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    mappingIds,
  });
}

describe('progress events', () => {
  it('goes queued -> processing (per step) -> finished, and clears the active list', async () => {
    const jobId = addJobWithFiles('two-step', 5, 2);

    const result = await executeJob(db, jobId, 'manual');

    expect(result.filesMoved).toBe(10);
    expect(events[0].phase).toBe('queued');
    expect(events[events.length - 1]).toMatchObject({ jobId, phase: 'finished' });

    const processing = events.filter((e) => e.phase === 'processing');
    expect(new Set(processing.map((e) => e.stepIndex))).toEqual(new Set([1, 2]));
    expect(processing.every((e) => e.stepCount === 2 && e.jobName === 'two-step')).toBe(true);
    expect(processing.find((e) => e.stepIndex === 1)?.stepName).toBe('two-step step 1');
    expect(getActiveRuns()).toEqual([]);
    expect(isJobActive(jobId)).toBe(false);
  });

  it('lists a running job as active, with its latest progress', async () => {
    const jobId = addJobWithFiles('active', 3);
    const running = executeJob(db, jobId, 'manual');

    expect(isJobActive(jobId)).toBe(true);
    expect(getActiveRuns().map((e) => e.jobId)).toEqual([jobId]);

    await running;
    expect(getActiveRuns()).toEqual([]);
  });

  it('still emits a finished event when the run fails', async () => {
    const jobId = addJobWithFiles('doomed', 1);
    repo.deleteJob(db, jobId);
    events.length = 0;

    await expect(executeJob(db, jobId, 'manual')).rejects.toThrow(/No job/);

    expect(events[events.length - 1]).toMatchObject({ jobId, phase: 'finished' });
    expect(getActiveRuns()).toEqual([]);
  });
});

describe('cancelJob', () => {
  it('cancels a job that is queued but has not started, touching nothing', async () => {
    const jobId = addJobWithFiles('queued', 5);
    const running = executeJob(db, jobId, 'manual');

    expect(cancelJob(jobId)).toBe(true);
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(result.filesMoved).toBe(0);
    expect(listTree(path.join(root, 'queued-0'))).toHaveLength(5);
  });

  it('stops a running job at the next file and skips its remaining steps', async () => {
    const jobId = addJobWithFiles('mid-run', 20, 2);
    // Cancel as soon as the first step reports it is processing.
    setRunProgressListener((e) => {
      events.push(e);
      if (e.phase === 'processing') cancelJob(jobId);
    });

    const result = await executeJob(db, jobId, 'manual');

    expect(result.cancelled).toBe(true);
    expect(result.filesMoved).toBeLessThan(20);
    // Step 2 never ran: nothing was ever moved into its destination.
    expect(listTree(path.join(root, 'mid-run-2'))).toEqual([]);
    expect(repo.listRuns(db, { jobId })).toHaveLength(1);
  });

  it('returns false for a job that is not running', () => {
    expect(cancelJob(424242)).toBe(false);
  });

  it('a cancelled job can be run again afterwards', async () => {
    const jobId = addJobWithFiles('rerun', 4);
    const first = executeJob(db, jobId, 'manual');
    cancelJob(jobId);
    await first;

    const second = await executeJob(db, jobId, 'manual');

    expect(second.cancelled).toBeUndefined();
    expect(second.filesMoved).toBe(4);
  });
});
