import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunResult } from '../../shared/types';
import { run } from '../database/dbHelpers';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { SchedulerService } from './scheduler';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;
let scheduler: SchedulerService;
let completed: { jobId: number; result: RunResult }[];

beforeEach(async () => {
  root = makeTempDir('fileshuttle-sched-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  completed = [];
  scheduler = new SchedulerService(db, (jobId, result) => completed.push({ jobId, result }));
});
afterEach(() => {
  scheduler.shutdown();
  db.close();
  removeDir(root);
});

const waitForRuns = async (count: number) => {
  await vi.waitFor(() => expect(completed.length).toBeGreaterThanOrEqual(count), { timeout: 5000 });
};

function addJob(
  name: string,
  schedule: { scheduleType: 'interval' | 'daily_at' | 'manual' | 'watch'; minutes?: number; times?: string[] },
  catchUp: boolean
): { jobId: number; src: string; dest: string } {
  const src = path.join(root, `${name}-src`);
  const dest = path.join(root, `${name}-dest`);
  writeFile(path.join(src, 'file.txt'));
  const mappingId = repo.createMapping(db, {
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
    nextMappingId: null,
    actionType: 'move',
    keepNewest: null,
  });
  const jobId = repo.createJob(db, {
    name,
    enabled: true,
    catchUp,
    scheduleType: schedule.scheduleType,
    scheduleIntervalMinutes: schedule.minutes ?? null,
    scheduleDailyTimes: schedule.times ?? [],
    mappingIds: [mappingId],
  });
  return { jobId, src, dest };
}

const backdate = (jobId: number, iso: string) => run(db, 'UPDATE jobs SET created_at = ? WHERE id = ?', [iso, jobId]);

describe('catchUp', () => {
  it('runs an opted-in interval job that is overdue, then records that it ran', async () => {
    const { jobId, dest } = addJob('overdue', { scheduleType: 'interval', minutes: 60 }, true);
    backdate(jobId, '2020-01-01T00:00:00.000Z');

    expect(scheduler.catchUp()).toBe(1);
    await waitForRuns(1);

    expect(listTree(dest)).toEqual(['file.txt']);
    const job = repo.getJob(db, jobId)!;
    expect(job.lastRunAt).not.toBeNull();
    expect(Date.now() - Date.parse(job.lastRunAt!)).toBeLessThan(60_000);
    // Now that it has run, it is no longer overdue.
    expect(scheduler.catchUp()).toBe(0);
  });

  it('runs an opted-in daily job that missed its time', async () => {
    const { jobId, dest } = addJob('daily', { scheduleType: 'daily_at', times: ['09:00'] }, true);
    backdate(jobId, '2020-01-01T00:00:00.000Z');

    expect(scheduler.catchUp(new Date(2026, 5, 10, 14, 0))).toBe(1);
    await waitForRuns(1);
    expect(listTree(dest)).toEqual(['file.txt']);
  });

  it('does not run a job that has not opted in', () => {
    const { jobId, src } = addJob('no-optin', { scheduleType: 'interval', minutes: 60 }, false);
    backdate(jobId, '2020-01-01T00:00:00.000Z');

    expect(scheduler.catchUp()).toBe(0);
    expect(listTree(src)).toEqual(['file.txt']);
  });

  it('does not run a job that is not yet due', () => {
    addJob('fresh', { scheduleType: 'interval', minutes: 60 }, true); // created just now
    expect(scheduler.catchUp()).toBe(0);
  });

  it('ignores manual jobs and disabled jobs', () => {
    const manual = addJob('manual', { scheduleType: 'manual' }, true);
    backdate(manual.jobId, '2020-01-01T00:00:00.000Z');
    const off = addJob('off', { scheduleType: 'interval', minutes: 60 }, true);
    backdate(off.jobId, '2020-01-01T00:00:00.000Z');
    repo.setJobEnabled(db, off.jobId, false);

    expect(scheduler.catchUp()).toBe(0);
  });

  it('does not stack a second run on one that is still going', async () => {
    const { jobId } = addJob('busy', { scheduleType: 'interval', minutes: 60 }, true);
    backdate(jobId, '2020-01-01T00:00:00.000Z');

    scheduler.catchUp();
    scheduler.catchUp(); // immediately again, while the first is queued/running
    await waitForRuns(1);
    await new Promise((r) => setTimeout(r, 200));

    expect(completed).toHaveLength(1);
  });
});
