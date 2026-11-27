import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { backupPathFor, preNativeCopyPathFor } from './dbFile';
import { queryAll, queryOne, run } from './dbHelpers';
import { initDatabase, repairIntegrity, takeRecoveryNotice } from './schema';
import { Database, openDatabase } from './sqlite';

// schema.ts pulls in Electron-only modules for the default db location and the
// startup log; neither is needed when an explicit path is passed.
vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let dir: string;
let dbPath: string;
let db: Database | null = null;

beforeEach(() => {
  dir = makeTempDir('fileshuttle-schema-');
  dbPath = path.join(dir, 'fileshuttle.db');
});
afterEach(() => {
  db?.close();
  db = null;
  removeDir(dir);
});

const fkEnabled = (d: Database) => Number(queryOne(d, 'PRAGMA foreign_keys')?.foreign_keys);
const count = (d: Database, table: string) => Number(queryOne(d, `SELECT COUNT(*) AS c FROM ${table}`)?.c);

function seedRun(d: Database): number {
  run(
    d,
    `INSERT INTO run_history (mapping_name_snapshot, trigger_type, started_at, finished_at, status)
     VALUES ('m', 'manual', '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', 'success')`
  );
  const runId = Number(queryOne(d, 'SELECT last_insert_rowid() AS id')?.id);
  run(d, "INSERT INTO run_history_files (run_id, source_path, outcome) VALUES (?, '/a', 'moved')", [runId]);
  run(d, "INSERT INTO run_history_files (run_id, source_path, outcome) VALUES (?, '/b', 'moved')", [runId]);
  return runId;
}

describe('initDatabase', () => {
  it('creates the database file on first run', async () => {
    db = await initDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(queryAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='run_history'")).toHaveLength(1);
  });

  it('opens in WAL mode with foreign keys enforced', async () => {
    db = await initDatabase(dbPath);
    expect(fkEnabled(db)).toBe(1);
    expect(queryOne(db, 'PRAGMA journal_mode')?.journal_mode).toBe('wal');
  });

  it('writes go straight to disk: another connection sees them with no save step', async () => {
    db = await initDatabase(dbPath);
    seedRun(db);
    const other = openDatabase(dbPath);
    try {
      expect(count(other, 'run_history')).toBe(1);
    } finally {
      other.close();
    }
  });

  it('cascades deletes of a run to its file rows', async () => {
    db = await initDatabase(dbPath);
    const runId = seedRun(db);
    expect(count(db, 'run_history_files')).toBe(2);
    run(db, 'DELETE FROM run_history WHERE id = ?', [runId]);
    expect(count(db, 'run_history_files')).toBe(0);
  });

  it('round-trips data through a reopen', async () => {
    db = await initDatabase(dbPath);
    seedRun(db);
    db.close();
    db = await initDatabase(dbPath);
    expect(count(db, 'run_history')).toBe(1);
    expect(count(db, 'run_history_files')).toBe(2);
  });
});

describe('repairIntegrity', () => {
  it('removes orphaned rows and nulls dangling references left by older builds', async () => {
    db = await initDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    run(db, "INSERT INTO run_history_files (run_id, source_path, outcome) VALUES (999, '/orphan', 'moved')");
    run(db, "INSERT INTO filter_rules (mapping_id, field, operator, value) VALUES (999, 'extension', 'equals', 'x')");
    run(db, 'INSERT INTO job_steps (job_id, mapping_id) VALUES (999, 999)');
    run(
      db,
      `INSERT INTO run_history (mapping_id, job_id, mapping_name_snapshot, trigger_type, started_at, finished_at, status)
       VALUES (999, 888, 'gone', 'manual', '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', 'success')`
    );

    repairIntegrity(db);

    expect(count(db, 'run_history_files')).toBe(0);
    expect(count(db, 'filter_rules')).toBe(0);
    expect(count(db, 'job_steps')).toBe(0);
    // The history row itself is kept (it has a name snapshot) but no longer dangles.
    const row = queryOne(db, 'SELECT mapping_id, job_id FROM run_history');
    expect(row).toEqual({ mapping_id: null, job_id: null });
  });

  it('lets a run be recorded after repair even though its old mapping was deleted', async () => {
    db = await initDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    run(
      db,
      `INSERT INTO run_history (mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at, status)
       VALUES (999, 'gone', 'manual', '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', 'success')`
    );
    repairIntegrity(db);
    db.exec('PRAGMA foreign_keys = ON');
    expect(() =>
      run(
        db!,
        `INSERT INTO run_history (mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at, status)
         VALUES ((SELECT mapping_id FROM run_history LIMIT 1), 'undo', 'undo', '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', 'success')`
      )
    ).not.toThrow();
  });
});

describe('recovery from a damaged database file', () => {
  /** Builds a real, valid database file at `target` containing one run. */
  async function writeValidDb(target: string): Promise<void> {
    const tmp = openDatabase(target);
    tmp.exec('CREATE TABLE marker (v TEXT)');
    tmp.exec("INSERT INTO marker VALUES ('from-backup')");
    tmp.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    tmp.close();
  }

  it('restores from the backup when the main file is garbage', async () => {
    await writeValidDb(backupPathFor(dbPath));
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all');

    db = await initDatabase(dbPath);

    expect(queryOne(db, 'SELECT v FROM marker')?.v).toBe('from-backup');
    const notice = takeRecoveryNotice();
    expect(notice).toMatch(/restored from a backup copy/);
    expect(takeRecoveryNotice()).toBeNull();
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('treats a zero-byte main file as damaged rather than as a fresh database', async () => {
    await writeValidDb(backupPathFor(dbPath));
    fs.writeFileSync(dbPath, '');

    db = await initDatabase(dbPath);

    expect(queryOne(db, 'SELECT v FROM marker')?.v).toBe('from-backup');
  });

  it('refuses to start, and does not overwrite the file, when there is no backup', async () => {
    fs.writeFileSync(dbPath, 'garbage with no backup');
    await expect(initDatabase(dbPath)).rejects.toThrow(/no backup/);
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('garbage with no backup');
  });
});

describe('copy before the first native open', () => {
  /** A database file as the sql.js build left it: rollback journal, no -wal. */
  function writeLegacyDb(target: string): void {
    const legacy = openDatabase(target);
    legacy.exec('PRAGMA journal_mode = DELETE');
    legacy.exec('CREATE TABLE marker (v TEXT)');
    legacy.exec("INSERT INTO marker VALUES ('original')");
    legacy.close();
  }

  it('copies an existing database beside itself before anything changes it', async () => {
    writeLegacyDb(dbPath);
    const before = fs.readFileSync(dbPath);

    db = await initDatabase(dbPath);

    const copyPath = preNativeCopyPathFor(dbPath);
    expect(fs.existsSync(copyPath)).toBe(true);
    expect(fs.readFileSync(copyPath).equals(before)).toBe(true);
    expect(fs.existsSync(copyPath + '.tmp')).toBe(false);
    // The copy is the untouched original: no migrations, still a rollback-journal file.
    const copy = openDatabase(copyPath);
    try {
      expect(queryAll(copy, "SELECT name FROM sqlite_master WHERE name='run_history'")).toHaveLength(0);
    } finally {
      copy.close();
    }
  });

  it('does not overwrite an existing copy on later launches', async () => {
    writeLegacyDb(dbPath);
    db = await initDatabase(dbPath);
    const copyPath = preNativeCopyPathFor(dbPath);
    const first = fs.readFileSync(copyPath);
    run(db, "INSERT INTO app_settings (key, value) VALUES ('later', 'x')");
    db.close();

    db = await initDatabase(dbPath);

    expect(fs.readFileSync(copyPath).equals(first)).toBe(true);
  });

  it('makes no copy on a fresh install', async () => {
    db = await initDatabase(dbPath);
    expect(fs.existsSync(preNativeCopyPathFor(dbPath))).toBe(false);
  });
});
