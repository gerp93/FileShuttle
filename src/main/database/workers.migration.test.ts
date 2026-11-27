import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { queryAll, queryOne, run } from './dbHelpers';
import { PRE_WORKERS_SUFFIX } from './dbFile';
import { STATEMENTS, initDatabase } from './schema';
import { Database, openDatabase } from './sqlite';
import * as repo from './repository';
import { getScheduleVersion, listWorkers } from './workers';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let dir: string;
let dbPath: string;
let db: Database | null = null;

beforeEach(() => {
  dir = makeTempDir('fileshuttle-workers-');
  dbPath = path.join(dir, 'fileshuttle.db');
});
afterEach(() => {
  db?.close();
  db = null;
  removeDir(dir);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const columnsOf = (d: Database, table: string) => queryAll(d, `PRAGMA table_info(${table})`).map((r) => String(r.name));

/** A database the way the last release left it: no workers, no worker_id, no run_uid. */
function writeLegacyDatabase(): void {
  const legacy = openDatabase(dbPath);
  legacy.exec('PRAGMA foreign_keys = ON');
  for (const statement of STATEMENTS) legacy.exec(statement);
  legacy.exec("INSERT INTO mappings (id, name, source_path, dest_path) VALUES (1, 'one', '/in', '/mid'), (2, 'two', '/mid', '/out')");
  legacy.exec('UPDATE mappings SET next_mapping_id = 2 WHERE id = 1');
  legacy.exec("INSERT INTO filter_rules (mapping_id, field, operator, value) VALUES (1, 'extension', 'equals', 'pdf')");
  legacy.exec("INSERT INTO jobs (id, name, schedule_type, schedule_interval_minutes) VALUES (7, 'job', 'interval', 30)");
  legacy.exec('INSERT INTO job_steps (job_id, mapping_id, sort_order) VALUES (7, 1, 0), (7, 2, 1)');
  legacy.exec(
    `INSERT INTO run_history (id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at, status, files_moved)
     VALUES (10, 1, 'one', 'manual', '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', 'success', 2),
            (11, 1, 'Undo of “one”', 'undo', '2024-01-01T01:00:00Z', '2024-01-01T01:00:01Z', 'success', 0)`
  );
  legacy.exec('UPDATE run_history SET undone_by_run_id = 11 WHERE id = 10');
  legacy.exec(
    "INSERT INTO run_history_files (run_id, source_path, dest_path, outcome) VALUES (10, '/in/a', '/mid/a', 'moved'), (10, '/in/b', '/mid/b', 'moved')"
  );
  legacy.exec("INSERT INTO app_settings (key, value) VALUES ('theme', 'hacker')");
  legacy.close();
}

describe('workers migration', () => {
  it('moves an old database onto one local worker, keeping everything', async () => {
    writeLegacyDatabase();

    db = await initDatabase(dbPath);

    const workers = listWorkers(db);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ kind: 'local', name: os.hostname().trim() || 'This PC' });
    expect(workers[0].id).toMatch(UUID);
    const workerId = workers[0].id;

    for (const table of ['mappings', 'jobs', 'run_history']) {
      expect(columnsOf(db, table)).toContain('worker_id');
      const rows = queryAll(db, `SELECT worker_id FROM ${table}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.worker_id === workerId)).toBe(true);
    }

    // Ids, links and file rows survived the rebuild.
    expect(queryAll(db, 'SELECT id FROM mappings ORDER BY id').map((r) => r.id)).toEqual([1, 2]);
    expect(queryOne(db, 'SELECT next_mapping_id FROM mappings WHERE id = 1')?.next_mapping_id).toBe(2);
    expect(queryOne(db, 'SELECT COUNT(*) AS c FROM filter_rules')?.c).toBe(1);
    expect(queryAll(db, 'SELECT mapping_id FROM job_steps WHERE job_id = 7 ORDER BY sort_order').map((r) => r.mapping_id)).toEqual([1, 2]);
    expect(queryOne(db, 'SELECT undone_by_run_id FROM run_history WHERE id = 10')?.undone_by_run_id).toBe(11);
    expect(queryOne(db, 'SELECT COUNT(*) AS c FROM run_history_files WHERE run_id = 10')?.c).toBe(2);
    expect(queryOne(db, "SELECT value FROM app_settings WHERE key = 'theme'")?.value).toBe('hacker');

    // Old runs got a uid each.
    const uids = queryAll(db, 'SELECT run_uid FROM run_history').map((r) => String(r.run_uid));
    expect(uids).toHaveLength(2);
    expect(new Set(uids).size).toBe(2);
    for (const uid of uids) expect(uid).toMatch(UUID);

    // Nothing dangles, and new rows continue after the old ids.
    expect(queryAll(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(repo.getJob(db, 7)).toMatchObject({ workerId, name: 'job' });
    const newRun = repo.recordRun(db, {
      mappingId: 1,
      mappingNameSnapshot: 'one',
      triggerType: 'manual',
      result: repo.buildRunResult(new Date(), new Date(), []),
      status: 'success',
    });
    expect(newRun).toBe(12);
    const mappingId = repo.createMapping(db, {
      name: 'three', sourcePath: '/x', destPath: '/y', recursive: false, conflictPolicy: 'skip', enabled: true,
      scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null,
      actionType: 'move', keepNewest: null, keepNewestPerExtension: false,
    });
    expect(mappingId).toBe(3);
  });

  it('indexes every worker_id and the other foreign-key columns', async () => {
    writeLegacyDatabase();
    db = await initDatabase(dbPath);
    const has = (table: string, column: string) =>
      queryAll(db!, `PRAGMA index_list(${table})`).some((idx) =>
        queryAll(db!, `PRAGMA index_info(${String(idx.name)})`).some((col) => col.name === column)
      );
    for (const [table, column] of [
      ['mappings', 'worker_id'], ['jobs', 'worker_id'], ['run_history', 'worker_id'],
      ['run_history', 'mapping_id'], ['run_history', 'job_id'], ['run_history', 'undone_by_run_id'],
      ['run_history', 'triggered_by_run_id'], ['run_history_files', 'run_id'], ['filter_rules', 'mapping_id'],
      ['job_steps', 'job_id'], ['job_steps', 'mapping_id'], ['mappings', 'next_mapping_id'],
    ]) {
      expect(has(table, column), `${table}.${column}`).toBe(true);
    }
  });

  it('is idempotent: a second start changes nothing and makes no second worker or copy', async () => {
    writeLegacyDatabase();
    db = await initDatabase(dbPath);
    const before = {
      workers: listWorkers(db),
      uids: queryAll(db, 'SELECT id, run_uid, worker_id FROM run_history ORDER BY id'),
    };
    db.close();
    const copyPath = dbPath + PRE_WORKERS_SUFFIX;
    const copyStat = fs.statSync(copyPath);

    db = await initDatabase(dbPath);

    expect(listWorkers(db)).toEqual(before.workers);
    expect(queryAll(db, 'SELECT id, run_uid, worker_id FROM run_history ORDER BY id')).toEqual(before.uids);
    expect(queryAll(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(fs.statSync(copyPath).mtimeMs).toBe(copyStat.mtimeMs);
  });

  it('keeps a copy of the old database, made once, under a temp name first, never overwritten', async () => {
    writeLegacyDatabase();
    db = await initDatabase(dbPath);
    const copyPath = dbPath + PRE_WORKERS_SUFFIX;
    expect(fs.existsSync(copyPath)).toBe(true);
    expect(fs.existsSync(copyPath + '.tmp')).toBe(false);
    const copy = openDatabase(copyPath);
    try {
      expect(columnsOf(copy, 'mappings')).not.toContain('worker_id');
      expect(queryOne(copy, 'SELECT COUNT(*) AS c FROM run_history')?.c).toBe(2);
    } finally {
      copy.close();
    }
  });

  it('never overwrites an existing pre-workers copy', async () => {
    writeLegacyDatabase();
    const copyPath = dbPath + PRE_WORKERS_SUFFIX;
    fs.writeFileSync(copyPath, 'an earlier copy');

    db = await initDatabase(dbPath);

    expect(fs.readFileSync(copyPath, 'utf8')).toBe('an earlier copy');
    expect(listWorkers(db)).toHaveLength(1); // the migration still happened
  });

  it('makes no copy for a brand-new database, which starts with its worker', async () => {
    db = await initDatabase(dbPath);
    expect(fs.existsSync(dbPath + PRE_WORKERS_SUFFIX)).toBe(false);
    expect(listWorkers(db)).toHaveLength(1);
  });
});

describe('run_uid', () => {
  it('stores a run reported twice once, and does not insert its file rows again', async () => {
    db = await initDatabase(dbPath);
    const outcome = { sourcePath: '/a', destPath: '/b', outcome: 'moved' as const, reason: null, sizeBytes: 1 };
    const params = {
      mappingId: null,
      mappingNameSnapshot: 'm',
      triggerType: 'manual' as const,
      result: repo.buildRunResult(new Date(), new Date(), [outcome]),
      status: 'success' as const,
      runUid: 'uid-1',
    };
    const first = repo.recordRunOnce(db, params);
    const second = repo.recordRunOnce(db, params);
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ runId: first.runId, duplicate: true });
    expect(queryOne(db, 'SELECT COUNT(*) AS c FROM run_history')?.c).toBe(1);
    expect(queryOne(db, 'SELECT COUNT(*) AS c FROM run_history_files')?.c).toBe(1);
  });

  it('is unique in the table itself', async () => {
    db = await initDatabase(dbPath);
    const insert = () =>
      run(
        db!,
        `INSERT INTO run_history (mapping_name_snapshot, trigger_type, started_at, finished_at, status, worker_id, run_uid)
         VALUES ('m', 'manual', 'a', 'b', 'success', (SELECT id FROM workers LIMIT 1), 'same')`
      );
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });
});

describe('schedule_version', () => {
  it('goes up by one for every change to a mapping, job, step, filter or schedule of the worker, and not for reads or last-run marks', async () => {
    db = await initDatabase(dbPath);
    const d = db;
    const workerId = listWorkers(d)[0].id;
    const version = () => getScheduleVersion(d, workerId);
    const start = version();
    const mappingInput = {
      name: 'm', sourcePath: '/a', destPath: '/b', recursive: false, conflictPolicy: 'skip' as const, enabled: true,
      scheduleType: 'manual' as const, scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [],
      nextMappingId: null, actionType: 'move' as const, keepNewest: null, keepNewestPerExtension: false,
    };

    const mappingId = repo.createMapping(d, mappingInput);
    expect(version()).toBe(start + 1);

    repo.updateMapping(d, mappingId, {
      ...mappingInput,
      filters: [{ field: 'extension', operator: 'equals', value: 'txt', group: 0 }],
    });
    expect(version()).toBe(start + 2); // the filter change is part of the same update

    repo.setMappingEnabled(d, mappingId, false);
    expect(version()).toBe(start + 3);

    const jobId = repo.createJob(d, {
      name: 'j', enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [],
      mappingIds: [mappingId],
    });
    expect(version()).toBe(start + 4); // the job and its steps, one change

    repo.updateJob(d, jobId, {
      name: 'j', enabled: true, scheduleType: 'interval', scheduleIntervalMinutes: 5, scheduleDailyTimes: [], mappingIds: [mappingId],
    });
    expect(version()).toBe(start + 5);

    repo.setJobEnabled(d, jobId, false);
    expect(version()).toBe(start + 6);

    repo.listJobs(d);
    repo.listMappings(d);
    repo.setJobLastRun(d, jobId, new Date().toISOString());
    expect(version()).toBe(start + 6); // reading, and a run finishing, change no schedule

    repo.deleteJob(d, jobId);
    expect(version()).toBe(start + 7);
    repo.deleteMapping(d, mappingId);
    expect(version()).toBe(start + 8);
  });
});
