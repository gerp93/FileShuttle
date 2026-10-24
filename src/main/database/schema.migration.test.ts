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
      nextMappingId: null,
      actionType: 'move',
      keepNewest: null,
    });
    const jobId = repo.createJob(db, {
      name: 'legacy job',
      enabled: true,
      scheduleType: 'interval',
      scheduleIntervalMinutes: 15,
      scheduleDailyTimes: [],
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
      scheduleDailyTimes: ['09:00'],
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
      scheduleDailyTimes: ['09:00'],
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
      scheduleDailyTimes: [],
      mappingIds: [],
    });
    expect(repo.getJob(db, jobId)?.catchUp).toBe(false);
    run(db, 'SELECT 1');
  });
});

describe('job daily times', () => {
  it('stores several times sorted and de-duplicated', async () => {
    db = await initDatabase(dbPath);
    const input = {
      name: 'j',
      enabled: true,
      scheduleType: 'daily_at' as const,
      scheduleIntervalMinutes: null,
      scheduleDailyTimes: ['17:00', '09:00', '09:00'],
      mappingIds: [],
    };
    const jobId = repo.createJob(db, input);
    expect(repo.getJob(db, jobId)?.scheduleDailyTimes).toEqual(['09:00', '17:00']);

    repo.updateJob(db, jobId, { ...input, scheduleDailyTimes: ['12:30'] });
    expect(repo.getJob(db, jobId)?.scheduleDailyTimes).toEqual(['12:30']);
  });

  it('carries a single time from before multiple times existed', async () => {
    db = await initDatabase(dbPath);
    const jobId = repo.createJob(db, {
      name: 'old',
      enabled: true,
      scheduleType: 'daily_at',
      scheduleIntervalMinutes: null,
      scheduleDailyTimes: ['08:15'],
      mappingIds: [],
    });
    db.run('ALTER TABLE jobs DROP COLUMN schedule_daily_times');
    saveDatabase(db);
    db.close();

    db = await initDatabase(dbPath);
    expect(repo.getJob(db, jobId)?.scheduleDailyTimes).toEqual(['08:15']);
  });
});

describe('filter groups', () => {
  const baseInput = {
    sourcePath: 'C:\in',
    destPath: 'C:\out',
    recursive: false,
    conflictPolicy: 'skip' as const,
    enabled: true,
    scheduleType: 'manual' as const,
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    nextMappingId: null,
    actionType: 'move' as const,
    keepNewest: null,
  };
  const ext = (value: string, group: number) => ({ field: 'extension' as const, operator: 'equals' as const, value, group });

  it('round-trip, tidied into consecutive groups', async () => {
    db = await initDatabase(dbPath);
    const id = repo.createMapping(db, { ...baseInput, name: 'm', filters: [ext('a', 4), ext('b', 9), ext('c', 4)] });
    expect(repo.getMapping(db, id)?.filters.map((f) => [f.value, f.group])).toEqual([['a', 0], ['c', 0], ['b', 1]]);
  });

  it('keep what the old match-ALL / match-ANY switch meant', async () => {
    db = await initDatabase(dbPath);
    const all = repo.createMapping(db, { ...baseInput, name: 'all', filters: [ext('a', 0), ext('b', 1), ext('c', 2)] });
    const any = repo.createMapping(db, { ...baseInput, name: 'any', filters: [ext('a', 0), ext('b', 0), ext('c', 0)] });
    // Rewind to the previous release's shape: a mode per mapping, no group column.
    run(db, "UPDATE mappings SET filter_match_mode = 'any' WHERE id = ?", [any]);
    db.run('ALTER TABLE filter_rules DROP COLUMN group_index');
    saveDatabase(db);
    db.close();

    db = await initDatabase(dbPath);

    expect(repo.getMapping(db, all)?.filters.map((f) => f.group)).toEqual([0, 1, 2]);
    expect(repo.getMapping(db, any)?.filters.map((f) => f.group)).toEqual([0, 0, 0]);
  });
});
