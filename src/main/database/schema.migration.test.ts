import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { queryAll, run } from './dbHelpers';
import * as repo from './repository';
import { initDatabase, saveDatabase } from './schema';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let dir: string;
let dbPath: string;
let db: Database | null = null;

beforeEach(() => {
  dir = makeTempDir('fileshuttle-migrate-');
  dbPath = path.join(dir, 'fileshuttle.db');
});
afterEach(() => {
  db?.close();
  db = null;
  removeDir(dir);
});

const columnsOf = (d: Database, table: string) => queryAll(d, `PRAGMA table_info(${table})`).map((r) => String(r.name));

describe('job catch-up columns', () => {
  it('are present on a fresh database', async () => {
    db = await initDatabase(dbPath);
    expect(columnsOf(db, 'jobs')).toEqual(expect.arrayContaining(['catch_up', 'last_run_at']));
  });

  it('are added to an existing database without losing its jobs', async () => {
    // Build a database the way the previous release left it: jobs without the new columns.
    db = await initDatabase(dbPath);
    const mappingId = repo.createMapping(db, {
      name: 'm',
      sourcePath: 'C:\\in',
      destPath: 'C:\\out',
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
    });
    const jobId = repo.createJob(db, {
      name: 'legacy job',
      enabled: true,
      scheduleType: 'interval',
      scheduleIntervalMinutes: 15,
      scheduleDailyTime: null,
      mappingIds: [mappingId],
    });
    db.run('ALTER TABLE jobs DROP COLUMN catch_up');
    db.run('ALTER TABLE jobs DROP COLUMN last_run_at');
    expect(columnsOf(db, 'jobs')).not.toContain('catch_up');
    saveDatabase(db);
    db.close();

    db = await initDatabase(dbPath);

    expect(columnsOf(db, 'jobs')).toEqual(expect.arrayContaining(['catch_up', 'last_run_at']));
    const job = repo.getJob(db, jobId)!;
    expect(job).toMatchObject({ name: 'legacy job', scheduleIntervalMinutes: 15, catchUp: false, lastRunAt: null });
    expect(job.steps).toHaveLength(1);
  });
});

describe('job catch-up persistence', () => {
  it('round-trips the flag and last-run time', async () => {
    db = await initDatabase(dbPath);
    const jobId = repo.createJob(db, {
      name: 'j',
      enabled: true,
      catchUp: true,
      scheduleType: 'daily_at',
      scheduleIntervalMinutes: null,
      scheduleDailyTime: '09:00',
      mappingIds: [],
    });
    expect(repo.getJob(db, jobId)).toMatchObject({ catchUp: true, lastRunAt: null });

    repo.setJobLastRun(db, jobId, '2026-03-10T09:00:00.000Z');
    expect(repo.getJob(db, jobId)?.lastRunAt).toBe('2026-03-10T09:00:00.000Z');

    repo.updateJob(db, jobId, {
      name: 'j',
      enabled: true,
      catchUp: false,
      scheduleType: 'daily_at',
      scheduleIntervalMinutes: null,
      scheduleDailyTime: '09:00',
      mappingIds: [],
    });
    const updated = repo.getJob(db, jobId)!;
    expect(updated.catchUp).toBe(false);
    // Editing a job must not forget when it last ran.
    expect(updated.lastRunAt).toBe('2026-03-10T09:00:00.000Z');
  });

  it('defaults to off when the input omits it', async () => {
    db = await initDatabase(dbPath);
    const jobId = repo.createJob(db, {
      name: 'j',
      enabled: true,
      scheduleType: 'manual',
      scheduleIntervalMinutes: null,
      scheduleDailyTime: null,
      mappingIds: [],
    });
    expect(repo.getJob(db, jobId)?.catchUp).toBe(false);
    run(db, 'SELECT 1');
  });
});
