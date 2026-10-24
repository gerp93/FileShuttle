import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { getEffectiveDbPath } from '../dbLocation';
import { logStartupStep } from '../startupLog';
import { loadWithBackupFallback, saveDatabaseFile } from './dbFile';

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;
let recoveryNotice: string | null = null;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mappings (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    source_path                 TEXT NOT NULL,
    dest_path                   TEXT NOT NULL,
    recursive                   INTEGER NOT NULL DEFAULT 0,
    action_type                 TEXT NOT NULL DEFAULT 'move'
                                 CHECK (action_type IN ('move','copy','delete','zip','unzip')),
    conflict_policy             TEXT NOT NULL DEFAULT 'skip'
                                 CHECK (conflict_policy IN ('overwrite','skip','auto_rename')),
    filter_match_mode           TEXT NOT NULL DEFAULT 'all'
                                 CHECK (filter_match_mode IN ('all','any')),
    keep_newest                 INTEGER,
    keep_newest_per_extension   INTEGER NOT NULL DEFAULT 0,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                 CHECK (schedule_type IN ('manual','interval','daily_at','watch')),
    schedule_interval_minutes   INTEGER,
    schedule_daily_time         TEXT,
    next_mapping_id             INTEGER REFERENCES mappings(id) ON DELETE SET NULL,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS filter_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id   INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
    field        TEXT NOT NULL CHECK (field IN
                 ('extension','filename_glob','filename_regex','size','modified_date','created_date')),
    operator     TEXT NOT NULL CHECK (operator IN ('equals','matches','min','max','before','after')),
    value        TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    group_index  INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS run_history (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id             INTEGER REFERENCES mappings(id) ON DELETE CASCADE,
    mapping_name_snapshot  TEXT NOT NULL,
    trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo','system')),
    started_at             TEXT NOT NULL,
    finished_at            TEXT NOT NULL,
    files_moved            INTEGER NOT NULL DEFAULT 0,
    files_copied           INTEGER NOT NULL DEFAULT 0,
    files_deleted          INTEGER NOT NULL DEFAULT 0,
    files_skipped          INTEGER NOT NULL DEFAULT 0,
    files_errored          INTEGER NOT NULL DEFAULT 0,
    files_extracted        INTEGER NOT NULL DEFAULT 0,
    files_zipped           INTEGER NOT NULL DEFAULT 0,
    status                 TEXT NOT NULL CHECK (status IN ('success','with_skips','partial','error')),
    error_message          TEXT,
    undone_by_run_id       INTEGER REFERENCES run_history(id) ON DELETE SET NULL,
    triggered_by_run_id    INTEGER REFERENCES run_history(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_history_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    source_path     TEXT NOT NULL,
    dest_path       TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN ('moved','copied','deleted','skipped','error','extracted','zipped')),
    reason          TEXT,
    file_size_bytes INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                 CHECK (schedule_type IN ('manual','interval','daily_at','watch')),
    schedule_interval_minutes   INTEGER,
    schedule_daily_time         TEXT,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS job_steps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    mapping_id   INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`,
];

/** Adds the column when it is absent; returns true only when this call added it. */
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): boolean {
  const rows = db.exec(`PRAGMA table_info(${table})`);
  if (!rows.length) return false;
  const existing = new Set(rows[0].values.map((row) => String(row[1])));
  if (existing.has(column)) return false;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function rewriteRunHistoryFilesTable(db: Database, alreadyHasToken: string, outcomeCheck: string): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_history_files'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes(alreadyHasToken)) return;

  // Older builds (and SQLite's default FK-off mode) could leave file rows
  // whose parent run was deleted. Re-inserting those with FKs on throws
  // and leaves startup stuck on the loading screen.
  db.run('PRAGMA foreign_keys = OFF');
  db.run('ALTER TABLE run_history_files RENAME TO run_history_files_old');
  db.run(`CREATE TABLE run_history_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    source_path     TEXT NOT NULL,
    dest_path       TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN (${outcomeCheck})),
    reason          TEXT,
    file_size_bytes INTEGER
  )`);
  db.run(
    'INSERT INTO run_history_files (id, run_id, source_path, dest_path, outcome, reason, file_size_bytes) ' +
      'SELECT old.id, old.run_id, old.source_path, old.dest_path, old.outcome, old.reason, old.file_size_bytes ' +
      'FROM run_history_files_old old INNER JOIN run_history r ON r.id = old.run_id'
  );
  db.run('DROP TABLE run_history_files_old');
  db.run('PRAGMA foreign_keys = ON');
}

function widenRunHistoryFilesOutcomeCheck(db: Database): void {
  rewriteRunHistoryFilesTable(db, "'copied'", "'moved','copied','deleted','skipped','error'");
}

function widenRunHistoryForSystemEvents(db: Database): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_history'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes("'system'")) return;

  db.run('PRAGMA foreign_keys = OFF');
  db.run(`CREATE TABLE run_history_new (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id             INTEGER REFERENCES mappings(id) ON DELETE CASCADE,
    mapping_name_snapshot  TEXT NOT NULL,
    trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo','system')),
    started_at             TEXT NOT NULL,
    finished_at            TEXT NOT NULL,
    files_moved            INTEGER NOT NULL DEFAULT 0,
    files_copied           INTEGER NOT NULL DEFAULT 0,
    files_deleted          INTEGER NOT NULL DEFAULT 0,
    files_skipped          INTEGER NOT NULL DEFAULT 0,
    files_errored          INTEGER NOT NULL DEFAULT 0,
    status                 TEXT NOT NULL CHECK (status IN ('success','with_skips','partial','error')),
    error_message          TEXT,
    undone_by_run_id       INTEGER REFERENCES run_history_new(id) ON DELETE SET NULL,
    triggered_by_run_id    INTEGER REFERENCES run_history_new(id) ON DELETE SET NULL,
    job_id                 INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    job_name_snapshot      TEXT
  )`);
  db.run(`INSERT INTO run_history_new
    (id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
     files_moved, files_copied, files_deleted, files_skipped, files_errored,
     status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot)
    SELECT
      id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
      files_moved, files_copied, files_deleted, files_skipped, files_errored,
      status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot
    FROM run_history`);
  db.run('DROP TABLE run_history');
  db.run('ALTER TABLE run_history_new RENAME TO run_history');
  db.run('PRAGMA foreign_keys = ON');
}

function widenRunHistoryStatusCheck(db: Database): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_history'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes("'with_skips'")) return;

  db.run('PRAGMA foreign_keys = OFF');
  db.run(`CREATE TABLE run_history_new (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id             INTEGER REFERENCES mappings(id) ON DELETE CASCADE,
    mapping_name_snapshot  TEXT NOT NULL,
    trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo','system')),
    started_at             TEXT NOT NULL,
    finished_at            TEXT NOT NULL,
    files_moved            INTEGER NOT NULL DEFAULT 0,
    files_copied           INTEGER NOT NULL DEFAULT 0,
    files_deleted          INTEGER NOT NULL DEFAULT 0,
    files_skipped          INTEGER NOT NULL DEFAULT 0,
    files_errored          INTEGER NOT NULL DEFAULT 0,
    status                 TEXT NOT NULL CHECK (status IN ('success','with_skips','partial','error')),
    error_message          TEXT,
    undone_by_run_id       INTEGER REFERENCES run_history_new(id) ON DELETE SET NULL,
    triggered_by_run_id    INTEGER REFERENCES run_history_new(id) ON DELETE SET NULL,
    job_id                 INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    job_name_snapshot      TEXT
  )`);
  db.run(`INSERT INTO run_history_new
    (id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
     files_moved, files_copied, files_deleted, files_skipped, files_errored,
     status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot)
    SELECT
      id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
      files_moved, files_copied, files_deleted, files_skipped, files_errored,
      status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot
    FROM run_history`);
  db.run('DROP TABLE run_history');
  db.run('ALTER TABLE run_history_new RENAME TO run_history');
  db.run('PRAGMA foreign_keys = ON');
}

function widenMappingsActionTypeCheck(db: Database): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='mappings'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes("'copy'")) return;

  db.run('PRAGMA foreign_keys = OFF');
  db.run(`CREATE TABLE mappings_new (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    source_path                 TEXT NOT NULL,
    dest_path                   TEXT NOT NULL,
    recursive                   INTEGER NOT NULL DEFAULT 0,
    action_type                 TEXT NOT NULL DEFAULT 'move'
                                 CHECK (action_type IN ('move','copy','delete')),
    conflict_policy             TEXT NOT NULL DEFAULT 'skip'
                                 CHECK (conflict_policy IN ('overwrite','skip','auto_rename')),
    filter_match_mode           TEXT NOT NULL DEFAULT 'all'
                                 CHECK (filter_match_mode IN ('all','any')),
    keep_newest                 INTEGER,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                 CHECK (schedule_type IN ('manual','interval','daily_at')),
    schedule_interval_minutes   INTEGER,
    schedule_daily_time         TEXT,
    next_mapping_id             INTEGER REFERENCES mappings_new(id) ON DELETE SET NULL,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.run(`INSERT INTO mappings_new
    (id, name, source_path, dest_path, recursive, action_type, conflict_policy,
     filter_match_mode, enabled, schedule_type, schedule_interval_minutes,
     schedule_daily_time, next_mapping_id, created_at, updated_at)
    SELECT
      id, name, source_path, dest_path, recursive, action_type, conflict_policy,
      filter_match_mode, enabled, schedule_type, schedule_interval_minutes,
      schedule_daily_time, next_mapping_id, created_at, updated_at
    FROM mappings`);
  db.run('DROP TABLE mappings');
  db.run('ALTER TABLE mappings_new RENAME TO mappings');
  db.run('PRAGMA foreign_keys = ON');
}

function widenRunHistoryFilesOutcomeCheckForZip(db: Database): void {
  rewriteRunHistoryFilesTable(
    db,
    "'extracted'",
    "'moved','copied','deleted','skipped','error','extracted','zipped'"
  );
}

function widenMappingsActionTypeCheckForZip(db: Database): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='mappings'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes("'zip'")) return;

  db.run('PRAGMA foreign_keys = OFF');
  db.run(`CREATE TABLE mappings_new (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    source_path                 TEXT NOT NULL,
    dest_path                   TEXT NOT NULL,
    recursive                   INTEGER NOT NULL DEFAULT 0,
    action_type                 TEXT NOT NULL DEFAULT 'move'
                                 CHECK (action_type IN ('move','copy','delete','zip','unzip')),
    conflict_policy             TEXT NOT NULL DEFAULT 'skip'
                                 CHECK (conflict_policy IN ('overwrite','skip','auto_rename')),
    filter_match_mode           TEXT NOT NULL DEFAULT 'all'
                                 CHECK (filter_match_mode IN ('all','any')),
    keep_newest                 INTEGER,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                 CHECK (schedule_type IN ('manual','interval','daily_at','watch')),
    schedule_interval_minutes   INTEGER,
    schedule_daily_time         TEXT,
    next_mapping_id             INTEGER REFERENCES mappings_new(id) ON DELETE SET NULL,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.run(`INSERT INTO mappings_new
    (id, name, source_path, dest_path, recursive, action_type, conflict_policy,
     filter_match_mode, keep_newest, enabled, schedule_type, schedule_interval_minutes,
     schedule_daily_time, next_mapping_id, created_at, updated_at)
    SELECT
      id, name, source_path, dest_path, recursive, action_type, conflict_policy,
      filter_match_mode, keep_newest, enabled, schedule_type, schedule_interval_minutes,
      schedule_daily_time, next_mapping_id, created_at, updated_at
    FROM mappings`);
  db.run('DROP TABLE mappings');
  db.run('ALTER TABLE mappings_new RENAME TO mappings');
  db.run('PRAGMA foreign_keys = ON');
}

function widenJobsScheduleTypeCheckForWatch(db: Database): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes("'watch'")) return;

  db.run('PRAGMA foreign_keys = OFF');
  db.run(`CREATE TABLE jobs_new (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                 CHECK (schedule_type IN ('manual','interval','daily_at','watch')),
    schedule_interval_minutes   INTEGER,
    schedule_daily_time         TEXT,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.run(`INSERT INTO jobs_new
    (id, name, enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, created_at, updated_at)
    SELECT
      id, name, enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, created_at, updated_at
    FROM jobs`);
  db.run('DROP TABLE jobs');
  db.run('ALTER TABLE jobs_new RENAME TO jobs');
  db.run('PRAGMA foreign_keys = ON');
}

function initSchema(db: Database): void {
  const step = (label: string, fn: () => void) => {
    logStartupStep(`initSchema: ${label}`);
    fn();
  };

  db.run('PRAGMA foreign_keys = ON');
  step('CREATE TABLE IF NOT EXISTS', () => {
    for (const statement of STATEMENTS) {
      db.run(statement);
    }
  });
  step('add missing mapping/history columns', () => {
    addColumnIfMissing(db, 'mappings', 'next_mapping_id', 'next_mapping_id INTEGER REFERENCES mappings(id) ON DELETE SET NULL');
    addColumnIfMissing(
      db,
      'mappings',
      'action_type',
      "action_type TEXT NOT NULL DEFAULT 'move' CHECK (action_type IN ('move','copy','delete'))"
    );
    addColumnIfMissing(
      db,
      'run_history',
      'triggered_by_run_id',
      'triggered_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL'
    );
    addColumnIfMissing(db, 'run_history', 'files_deleted', 'files_deleted INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'run_history', 'files_copied', 'files_copied INTEGER NOT NULL DEFAULT 0');
  });
  step('widenRunHistoryFilesOutcomeCheck', () => widenRunHistoryFilesOutcomeCheck(db));
  step('widenMappingsActionTypeCheck', () => widenMappingsActionTypeCheck(db));
  step('add keep_newest / job snapshot columns', () => {
    addColumnIfMissing(db, 'mappings', 'keep_newest', 'keep_newest INTEGER');
    addColumnIfMissing(
      db,
      'run_history',
      'job_id',
      'job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL'
    );
    addColumnIfMissing(db, 'run_history', 'job_name_snapshot', 'job_name_snapshot TEXT');
  });
  step('widenRunHistoryForSystemEvents', () => widenRunHistoryForSystemEvents(db));
  step('widenRunHistoryStatusCheck', () => widenRunHistoryStatusCheck(db));
  step('add zip count columns', () => {
    addColumnIfMissing(db, 'run_history', 'files_extracted', 'files_extracted INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'run_history', 'files_zipped', 'files_zipped INTEGER NOT NULL DEFAULT 0');
  });
  step('widenRunHistoryFilesOutcomeCheckForZip', () => widenRunHistoryFilesOutcomeCheckForZip(db));
  step('widenMappingsActionTypeCheckForZip', () => widenMappingsActionTypeCheckForZip(db));
  step('widenJobsScheduleTypeCheckForWatch', () => widenJobsScheduleTypeCheckForWatch(db));
  // Must stay after the jobs-table rebuild above, which only copies the columns it knows about.
  step('add job catch-up columns', () => {
    addColumnIfMissing(db, 'jobs', 'catch_up', 'catch_up INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'jobs', 'last_run_at', 'last_run_at TEXT');
  });
  step('add filter group column', () => {
    const added = addColumnIfMissing(db, 'filter_rules', 'group_index', 'group_index INTEGER NOT NULL DEFAULT 0');
    if (!added) return;
    // Before groups, one per-mapping switch decided AND vs OR for the whole list. Keep what each
    // mapping did: "any" puts every rule in one group, "all" gives every rule a group of its own.
    db.run(
      `UPDATE filter_rules SET group_index = CASE
         WHEN (SELECT filter_match_mode FROM mappings m WHERE m.id = filter_rules.mapping_id) = 'any' THEN 0
         ELSE sort_order
       END`
    );
  });
  // Must stay after the mappings-table rebuilds above, which only copy the columns they know about.
  step('add keep-newest-per-extension column', () => {
    addColumnIfMissing(
      db,
      'mappings',
      'keep_newest_per_extension',
      'keep_newest_per_extension INTEGER NOT NULL DEFAULT 0'
    );
  });
  step('add job daily times column', () => {
    addColumnIfMissing(db, 'jobs', 'schedule_daily_times', 'schedule_daily_times TEXT');
    db.run(
      `UPDATE jobs SET schedule_daily_times = schedule_daily_time
       WHERE schedule_daily_times IS NULL AND schedule_daily_time IS NOT NULL`
    );
  });
}

export async function initDatabase(dbPath?: string): Promise<Database> {
  logStartupStep('initDatabase: start, calling initSqlJs()');
  const SQL = await initSqlJs();
  logStartupStep('initDatabase: initSqlJs() resolved');
  dbPath = dbPath ?? getEffectiveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  logStartupStep(`initDatabase: opening db file at ${dbPath}`);
  const loaded = loadWithBackupFallback(dbPath, (bytes) => openValidated(SQL, bytes));
  const db = loaded.value;
  logStartupStep('initDatabase: database opened');
  recoveryNotice = loaded.recoveredFromBackup
    ? `FileShuttle's database file was unreadable, so it was restored from the most recent automatic backup. ` +
      `Changes made since that backup may be missing. The damaged file was kept at:\n${loaded.quarantinedTo}`
    : null;
  if (recoveryNotice) logStartupStep(`initDatabase: ${recoveryNotice}`);

  dbInstance = db;
  currentDbPath = dbPath;
  logStartupStep('initDatabase: running initSchema()');
  initSchema(db);
  logStartupStep('initDatabase: initSchema() done, repairing orphaned rows');
  repairIntegrity(db);
  logStartupStep('initDatabase: integrity repair done, calling saveDatabase()');
  saveDatabase(db, dbPath);
  logStartupStep('initDatabase: saveDatabase() done, returning');
  return db;
}

/**
 * An empty or non-database file doesn't throw when sql.js opens it -- only
 * when first queried -- so probe it here. A zero-byte file is explicitly
 * rejected: it is what a crash during the old truncate-then-write save left
 * behind, and treating it as "no data yet" would silently discard the backup.
 */
function openValidated(SQL: SqlJsStatic, bytes: Uint8Array | null): Database {
  if (!bytes) return new SQL.Database();
  if (bytes.length === 0) throw new Error('the database file is empty');

  const db = new SQL.Database(bytes);
  try {
    const verdict = String(db.exec('PRAGMA quick_check')[0]?.values[0]?.[0] ?? '');
    if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Foreign keys were effectively off for the whole session in older builds
 * (see saveDatabase), so deleting a run left its file rows behind, and deleted
 * mappings/jobs left dangling references. Clear those out once so enforcing
 * foreign keys again can't trip over them -- e.g. an undo of a run whose
 * mapping was deleted would otherwise fail with a constraint error.
 */
export function repairIntegrity(db: Database): void {
  db.run('DELETE FROM run_history_files WHERE run_id NOT IN (SELECT id FROM run_history)');
  db.run('DELETE FROM filter_rules WHERE mapping_id NOT IN (SELECT id FROM mappings)');
  db.run(
    'DELETE FROM job_steps WHERE job_id NOT IN (SELECT id FROM jobs) OR mapping_id NOT IN (SELECT id FROM mappings)'
  );
  db.run('UPDATE mappings SET next_mapping_id = NULL WHERE next_mapping_id NOT IN (SELECT id FROM mappings)');
  db.run('UPDATE run_history SET mapping_id = NULL WHERE mapping_id IS NOT NULL AND mapping_id NOT IN (SELECT id FROM mappings)');
  db.run('UPDATE run_history SET job_id = NULL WHERE job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM jobs)');
  db.run(
    'UPDATE run_history SET undone_by_run_id = NULL WHERE undone_by_run_id IS NOT NULL AND undone_by_run_id NOT IN (SELECT id FROM run_history)'
  );
  db.run(
    'UPDATE run_history SET triggered_by_run_id = NULL WHERE triggered_by_run_id IS NOT NULL AND triggered_by_run_id NOT IN (SELECT id FROM run_history)'
  );
}

export function saveDatabase(db: Database, dbPath?: string): void {
  if (!dbPath) {
    dbPath = currentDbPath ?? getEffectiveDbPath();
  }
  const data = db.export();
  // sql.js's export() closes and re-opens the database, which silently resets
  // every pragma -- including foreign_keys back to OFF. Without this, the
  // schema's ON DELETE CASCADE/SET NULL rules never fire after the first save.
  db.run('PRAGMA foreign_keys = ON');
  saveDatabaseFile(dbPath, data);
}

/** Set when startup had to restore the database from its backup; shown to the user once. */
export function takeRecoveryNotice(): string | null {
  const notice = recoveryNotice;
  recoveryNotice = null;
  return notice;
}

export function getDatabase(): Database | null {
  return dbInstance;
}

export function getCurrentDbPath(): string | null {
  return currentDbPath;
}
