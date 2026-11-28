import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { getEffectiveDbPath } from '../dbLocation';
import { logStartupStep } from '../startupLog';
import { copyBeforeFirstNativeOpen, copyBeforeWorkersMigration, loadWithBackupFallback } from './dbFile';
import { queryAll, queryOne } from './dbHelpers';
import { checkpoint, Database, openDatabase, transaction } from './sqlite';

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;
let recoveryNotice: string | null = null;

export const STATEMENTS = [
  // Access tokens for the MCP server. Only a SHA-256 hash of each token is kept, never the token.
  `CREATE TABLE IF NOT EXISTS mcp_tokens (
    name          TEXT PRIMARY KEY COLLATE NOCASE,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
  )`,
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
                 ('extension','filename_glob','filename_regex','size','modified_date','created_date','download_source')),
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

/** The CREATE statement of a table, or null when it does not exist. */
function tableSql(db: Database, table: string): string | null {
  const row = queryOne(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table]);
  return row ? String(row.sql ?? '') : null;
}

// SQLite can't alter a CHECK in place, so a table is rebuilt: new table, copy, drop, rename.
// Foreign keys must be off while that happens (dropping a parent would otherwise cascade),
// and PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around one.
// The rebuild is atomic: if a statement fails the transaction is never committed.
function beginRebuild(db: Database): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
}

function endRebuild(db: Database): void {
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON');
}

/** Adds the column when it is absent; returns true only when this call added it. */
function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): boolean {
  const rows = queryAll(db, `PRAGMA table_info(${table})`);
  if (!rows.length) return false;
  const existing = new Set(rows.map((row) => String(row.name)));
  if (existing.has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function rewriteRunHistoryFilesTable(db: Database, alreadyHasToken: string, outcomeCheck: string): void {
  const sql = tableSql(db, 'run_history_files');
  if (sql === null) return;
  if (sql.includes(alreadyHasToken)) return;

  // Older builds (and SQLite's default FK-off mode) could leave file rows
  // whose parent run was deleted. Re-inserting those with FKs on throws
  // and leaves startup stuck on the loading screen.
  beginRebuild(db);
  db.exec('ALTER TABLE run_history_files RENAME TO run_history_files_old');
  db.exec(`CREATE TABLE run_history_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    source_path     TEXT NOT NULL,
    dest_path       TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN (${outcomeCheck})),
    reason          TEXT,
    file_size_bytes INTEGER
  )`);
  db.exec(
    'INSERT INTO run_history_files (id, run_id, source_path, dest_path, outcome, reason, file_size_bytes) ' +
      'SELECT old.id, old.run_id, old.source_path, old.dest_path, old.outcome, old.reason, old.file_size_bytes ' +
      'FROM run_history_files_old old INNER JOIN run_history r ON r.id = old.run_id'
  );
  db.exec('DROP TABLE run_history_files_old');
  endRebuild(db);
}

function widenRunHistoryFilesOutcomeCheck(db: Database): void {
  rewriteRunHistoryFilesTable(db, "'copied'", "'moved','copied','deleted','skipped','error'");
}

function widenRunHistoryForSystemEvents(db: Database): void {
  const sql = tableSql(db, 'run_history');
  if (sql === null) return;
  if (sql.includes("'system'")) return;

  beginRebuild(db);
  db.exec(`CREATE TABLE run_history_new (
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
  db.exec(`INSERT INTO run_history_new
    (id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
     files_moved, files_copied, files_deleted, files_skipped, files_errored,
     status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot)
    SELECT
      id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
      files_moved, files_copied, files_deleted, files_skipped, files_errored,
      status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot
    FROM run_history`);
  db.exec('DROP TABLE run_history');
  db.exec('ALTER TABLE run_history_new RENAME TO run_history');
  endRebuild(db);
}

function widenRunHistoryStatusCheck(db: Database): void {
  const sql = tableSql(db, 'run_history');
  if (sql === null) return;
  if (sql.includes("'with_skips'")) return;

  beginRebuild(db);
  db.exec(`CREATE TABLE run_history_new (
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
  db.exec(`INSERT INTO run_history_new
    (id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
     files_moved, files_copied, files_deleted, files_skipped, files_errored,
     status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot)
    SELECT
      id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
      files_moved, files_copied, files_deleted, files_skipped, files_errored,
      status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot
    FROM run_history`);
  db.exec('DROP TABLE run_history');
  db.exec('ALTER TABLE run_history_new RENAME TO run_history');
  endRebuild(db);
}

function widenMappingsActionTypeCheck(db: Database): void {
  const sql = tableSql(db, 'mappings');
  if (sql === null) return;
  if (sql.includes("'copy'")) return;

  beginRebuild(db);
  db.exec(`CREATE TABLE mappings_new (
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
  db.exec(`INSERT INTO mappings_new
    (id, name, source_path, dest_path, recursive, action_type, conflict_policy,
     filter_match_mode, enabled, schedule_type, schedule_interval_minutes,
     schedule_daily_time, next_mapping_id, created_at, updated_at)
    SELECT
      id, name, source_path, dest_path, recursive, action_type, conflict_policy,
      filter_match_mode, enabled, schedule_type, schedule_interval_minutes,
      schedule_daily_time, next_mapping_id, created_at, updated_at
    FROM mappings`);
  db.exec('DROP TABLE mappings');
  db.exec('ALTER TABLE mappings_new RENAME TO mappings');
  endRebuild(db);
}

function widenRunHistoryFilesOutcomeCheckForZip(db: Database): void {
  rewriteRunHistoryFilesTable(
    db,
    "'extracted'",
    "'moved','copied','deleted','skipped','error','extracted','zipped'"
  );
}

function widenMappingsActionTypeCheckForZip(db: Database): void {
  const sql = tableSql(db, 'mappings');
  if (sql === null) return;
  if (sql.includes("'zip'")) return;

  beginRebuild(db);
  db.exec(`CREATE TABLE mappings_new (
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
  db.exec(`INSERT INTO mappings_new
    (id, name, source_path, dest_path, recursive, action_type, conflict_policy,
     filter_match_mode, keep_newest, enabled, schedule_type, schedule_interval_minutes,
     schedule_daily_time, next_mapping_id, created_at, updated_at)
    SELECT
      id, name, source_path, dest_path, recursive, action_type, conflict_policy,
      filter_match_mode, keep_newest, enabled, schedule_type, schedule_interval_minutes,
      schedule_daily_time, next_mapping_id, created_at, updated_at
    FROM mappings`);
  db.exec('DROP TABLE mappings');
  db.exec('ALTER TABLE mappings_new RENAME TO mappings');
  endRebuild(db);
}

function widenJobsScheduleTypeCheckForWatch(db: Database): void {
  const sql = tableSql(db, 'jobs');
  if (sql === null) return;
  if (sql.includes("'watch'")) return;

  beginRebuild(db);
  db.exec(`CREATE TABLE jobs_new (
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
  db.exec(`INSERT INTO jobs_new
    (id, name, enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, created_at, updated_at)
    SELECT
      id, name, enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, created_at, updated_at
    FROM jobs`);
  db.exec('DROP TABLE jobs');
  db.exec('ALTER TABLE jobs_new RENAME TO jobs');
  endRebuild(db);
}

/**
 * SQLite can't change a CHECK in place, so databases created before the
 * "download source" filter existed are rebuilt with the wider field list.
 * Every existing rule is copied across unchanged.
 */
function widenFilterFieldCheckForDownloadSource(db: Database): void {
  const sql = tableSql(db, 'filter_rules');
  if (sql === null) return;
  if (sql.includes("'download_source'")) return;

  beginRebuild(db);
  db.exec(`CREATE TABLE filter_rules_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id   INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
    field        TEXT NOT NULL CHECK (field IN
                 ('extension','filename_glob','filename_regex','size','modified_date','created_date','download_source')),
    operator     TEXT NOT NULL CHECK (operator IN ('equals','matches','min','max','before','after')),
    value        TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    group_index  INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`INSERT INTO filter_rules_new (id, mapping_id, field, operator, value, sort_order, group_index)
    SELECT old.id, old.mapping_id, old.field, old.operator, old.value, old.sort_order, old.group_index
    FROM filter_rules old INNER JOIN mappings m ON m.id = old.mapping_id`);
  db.exec('DROP TABLE filter_rules');
  db.exec('ALTER TABLE filter_rules_new RENAME TO filter_rules');
  endRebuild(db);
}

const WORKERS_TABLE = `CREATE TABLE IF NOT EXISTS workers (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    kind                    TEXT NOT NULL,
    token_hash              TEXT,
    app_version             TEXT,
    protocol_version        INTEGER,
    schedule_version        INTEGER NOT NULL DEFAULT 0,
    schedule_acked_version  INTEGER NOT NULL DEFAULT 0,
    last_seen_at            TEXT,
    created_at              TEXT NOT NULL
  )`;

/** A random version-4 uuid, made by SQLite so a table copy can give every old row its own. */
const SQL_UUID =
  "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || " +
  "substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";

function hasColumn(db: Database, table: string, column: string): boolean {
  return queryAll(db, `PRAGMA table_info(${table})`).some((row) => String(row.name) === column);
}

/** True while the data model predates workers (some table still lacks its worker_id / run_uid). */
function needsWorkersMigration(db: Database): boolean {
  return (
    !hasColumn(db, 'mappings', 'worker_id') ||
    !hasColumn(db, 'jobs', 'worker_id') ||
    !hasColumn(db, 'run_history', 'worker_id') ||
    !hasColumn(db, 'run_history', 'run_uid')
  );
}

function sequenceOf(db: Database, table: string): number | null {
  const row = queryOne(db, 'SELECT seq FROM sqlite_sequence WHERE name = ?', [table]);
  return row ? Number(row.seq) : null;
}

/** A rebuilt AUTOINCREMENT table must not hand out ids the old one already used. */
function restoreSequence(db: Database, table: string, seq: number | null): void {
  if (seq == null) return;
  db.prepare('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?').run(seq, table);
  db.prepare(
    'INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)'
  ).run(table, seq, table);
}

/**
 * Gives every mapping, job and run a worker, and every run a uid made on the worker.
 *
 * worker_id is NOT NULL, which SQLite can only add by rebuilding the tables, so the three
 * tables are rebuilt together in ONE transaction (the same rename-and-copy pattern as the
 * CHECK widenings above): a crash part-way leaves the old state or the new one, never a mix.
 * One `local` worker, named after this computer, takes everything that exists. Idempotent: once
 * the columns exist nothing is touched.
 */
function migrateToWorkers(db: Database): void {
  db.exec(WORKERS_TABLE);
  if (needsWorkersMigration(db)) {
    // The rebuild checks foreign keys at the end; clear the dangling rows older builds left first.
    repairIntegrity(db);

    const mappingsSeq = sequenceOf(db, 'mappings');
    const jobsSeq = sequenceOf(db, 'jobs');
    const runsSeq = sequenceOf(db, 'run_history');

    beginRebuild(db);
    try {
      let workerId = queryOne(db, "SELECT id FROM workers WHERE kind = 'local' ORDER BY created_at, id LIMIT 1")?.id;
      if (!workerId) {
        workerId = randomUUID();
        let name = 'This PC';
        try {
          name = os.hostname().trim() || name;
        } catch {
          // keep the generic name
        }
        db.prepare("INSERT INTO workers (id, name, kind, created_at) VALUES (?, ?, 'local', ?)").run(
          workerId as string,
          name,
          new Date().toISOString()
        );
      }
      const worker = String(workerId);

      db.exec(`CREATE TABLE mappings_new (
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
    next_mapping_id             INTEGER REFERENCES mappings_new(id) ON DELETE SET NULL,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    worker_id                   TEXT NOT NULL REFERENCES workers(id)
  )`);
      db.prepare(
        `INSERT INTO mappings_new
          (id, name, source_path, dest_path, recursive, action_type, conflict_policy, filter_match_mode,
           keep_newest, keep_newest_per_extension, enabled, schedule_type, schedule_interval_minutes,
           schedule_daily_time, next_mapping_id, created_at, updated_at, worker_id)
         SELECT id, name, source_path, dest_path, recursive, action_type, conflict_policy, filter_match_mode,
           keep_newest, keep_newest_per_extension, enabled, schedule_type, schedule_interval_minutes,
           schedule_daily_time, next_mapping_id, created_at, updated_at, ?
         FROM mappings`
      ).run(worker);
      db.exec('DROP TABLE mappings');
      db.exec('ALTER TABLE mappings_new RENAME TO mappings');

      db.exec(`CREATE TABLE jobs_new (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1,
    schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                 CHECK (schedule_type IN ('manual','interval','daily_at','watch')),
    schedule_interval_minutes   INTEGER,
    schedule_daily_time         TEXT,
    created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    catch_up                    INTEGER NOT NULL DEFAULT 0,
    last_run_at                 TEXT,
    schedule_daily_times        TEXT,
    worker_id                   TEXT NOT NULL REFERENCES workers(id)
  )`);
      db.prepare(
        `INSERT INTO jobs_new
          (id, name, enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, created_at, updated_at,
           catch_up, last_run_at, schedule_daily_times, worker_id)
         SELECT id, name, enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, created_at, updated_at,
           catch_up, last_run_at, schedule_daily_times, ?
         FROM jobs`
      ).run(worker);
      db.exec('DROP TABLE jobs');
      db.exec('ALTER TABLE jobs_new RENAME TO jobs');

      db.exec(`CREATE TABLE run_history_new (
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
    undone_by_run_id       INTEGER REFERENCES run_history_new(id) ON DELETE SET NULL,
    triggered_by_run_id    INTEGER REFERENCES run_history_new(id) ON DELETE SET NULL,
    job_id                 INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    job_name_snapshot      TEXT,
    worker_id              TEXT NOT NULL REFERENCES workers(id),
    run_uid                TEXT NOT NULL UNIQUE
  )`);
      db.prepare(
        `INSERT INTO run_history_new
          (id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
           files_moved, files_copied, files_deleted, files_skipped, files_errored, files_extracted, files_zipped,
           status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot, worker_id, run_uid)
         SELECT id, mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
           files_moved, files_copied, files_deleted, files_skipped, files_errored, files_extracted, files_zipped,
           status, error_message, undone_by_run_id, triggered_by_run_id, job_id, job_name_snapshot, ?, ${SQL_UUID}
         FROM run_history`
      ).run(worker);
      db.exec('DROP TABLE run_history');
      db.exec('ALTER TABLE run_history_new RENAME TO run_history');

      restoreSequence(db, 'mappings', mappingsSeq);
      restoreSequence(db, 'jobs', jobsSeq);
      restoreSequence(db, 'run_history', runsSeq);

      // Fail loudly, and roll everything back, if the rebuild left a broken reference.
      assertForeignKeysIntact(db, 'workers migration');
      endRebuild(db);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the failure that matters is the original one
      }
      db.exec('PRAGMA foreign_keys = ON');
      throw err;
    }
  }
  createIndexes(db);
}

/** Throws, naming the broken rows, when any foreign key does not resolve. */
function assertForeignKeysIntact(db: Database, context: string): void {
  const broken = queryAll(db, 'PRAGMA foreign_key_check');
  if (broken.length) {
    const first = broken[0];
    throw new Error(
      `${context}: foreign key check failed for ${broken.length} row(s), first in table ${String(first.table)} ` +
        `(row ${String(first.rowid)}, parent ${String(first.parent)}).`
    );
  }
}

/**
 * Every foreign-key child column is indexed: with no index, SQLite scans the whole child table
 * for each parent row it deletes (a mapping, a run, a worker). Idempotent.
 */
function createIndexes(db: Database): void {
  const indexes: [string, string, string][] = [
    ['idx_mappings_worker_id', 'mappings', 'worker_id'],
    ['idx_jobs_worker_id', 'jobs', 'worker_id'],
    ['idx_run_history_worker_id', 'run_history', 'worker_id'],
    ['idx_mappings_next_mapping_id', 'mappings', 'next_mapping_id'],
    ['idx_filter_rules_mapping_id', 'filter_rules', 'mapping_id'],
    ['idx_job_steps_job_id', 'job_steps', 'job_id'],
    ['idx_job_steps_mapping_id', 'job_steps', 'mapping_id'],
    ['idx_run_history_mapping_id', 'run_history', 'mapping_id'],
    ['idx_run_history_job_id', 'run_history', 'job_id'],
    ['idx_run_history_undone_by_run_id', 'run_history', 'undone_by_run_id'],
    ['idx_run_history_triggered_by_run_id', 'run_history', 'triggered_by_run_id'],
    ['idx_run_history_files_run_id', 'run_history_files', 'run_id'],
  ];
  for (const [name, table, column] of indexes) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${column})`);
  }
}

function initSchema(db: Database): void {
  const step = (label: string, fn: () => void) => {
    logStartupStep(`initSchema: ${label}`);
    fn();
  };

  db.exec('PRAGMA foreign_keys = ON');
  step('CREATE TABLE IF NOT EXISTS', () => {
    for (const statement of STATEMENTS) {
      db.exec(statement);
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
    db.exec(
      `UPDATE filter_rules SET group_index = CASE
         WHEN (SELECT filter_match_mode FROM mappings m WHERE m.id = filter_rules.mapping_id) = 'any' THEN 0
         ELSE sort_order
       END`
    );
  });
  // Must stay after 'add filter group column' above: this rebuild copies group_index.
  step('widenFilterFieldCheckForDownloadSource', () => widenFilterFieldCheckForDownloadSource(db));
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
    db.exec(
      `UPDATE jobs SET schedule_daily_times = schedule_daily_time
       WHERE schedule_daily_times IS NULL AND schedule_daily_time IS NOT NULL`
    );
  });
  // Must stay last: it rebuilds mappings, jobs and run_history, copying the columns every step above added.
  step('workers: worker_id, run_uid, indexes', () => migrateToWorkers(db));
  step('remote workers: columns, pairing codes, queued runs', () => migrateToRemoteWorkers(db));
}

/**
 * Phase 5a: what a remote worker needs. Plain additions (no table rebuild): the workers table gets
 * the machine's platform and when it was paired or removed; one-time pairing codes (only a hash of
 * each); and the "Run now" requests waiting for a machine that is offline.
 */
function migrateToRemoteWorkers(db: Database): void {
  addColumnIfMissing(db, 'workers', 'platform', 'platform TEXT');
  addColumnIfMissing(db, 'workers', 'paired_at', 'paired_at TEXT');
  addColumnIfMissing(db, 'workers', 'removed_at', 'removed_at TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS worker_pairing_codes (
    code_hash   TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS worker_pairing_failures (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    failures  INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS pending_runs (
    job_id      INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id   TEXT NOT NULL REFERENCES workers(id),
    trigger     TEXT NOT NULL,
    queued_at   TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pending_runs_worker ON pending_runs(worker_id)');
}

export async function initDatabase(dbPath?: string): Promise<Database> {
  logStartupStep('initDatabase: start');
  dbPath = dbPath ?? getEffectiveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Before anything below can change the file (opening in WAL mode and the migrations both do).
  if (copyBeforeFirstNativeOpen(dbPath)) {
    logStartupStep('initDatabase: kept a copy of the existing database before first native open');
  }

  logStartupStep(`initDatabase: opening db file at ${dbPath}`);
  const loaded = loadWithBackupFallback(dbPath, openValidated);
  const db = loaded.value;
  logStartupStep('initDatabase: database opened');
  recoveryNotice = loaded.recoveredFromBackup
    ? `FileShuttle's database file was unreadable, so it was restored from a backup copy. ` +
      `Changes made since that backup may be missing. The damaged file was kept at:\n${loaded.quarantinedTo}`
    : null;
  if (recoveryNotice) logStartupStep(`initDatabase: ${recoveryNotice}`);

  try {
    // Before the workers migration (or any older step before it) changes anything. A brand-new
    // database has no tables yet and needs no copy.
    const existing = queryOne(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='mappings'");
    if (existing && needsWorkersMigration(db) && copyBeforeWorkersMigration(dbPath, db)) {
      logStartupStep('initDatabase: kept a copy of the database before the workers migration');
    }
    logStartupStep('initDatabase: running initSchema()');
    initSchema(db);
    logStartupStep('initDatabase: initSchema() done, repairing orphaned rows');
    repairIntegrity(db);
  } catch (err) {
    // An unfinished rebuild transaction is rolled back by closing.
    db.close();
    throw err;
  }
  dbInstance = db;
  currentDbPath = dbPath;
  logStartupStep('initDatabase: integrity repair done, returning');
  return db;
}

/**
 * An empty or non-database file doesn't throw when opened -- only when first
 * queried -- so probe it here. A zero-byte file is explicitly rejected: it is what
 * a crash during an older truncate-then-write save left behind, and treating it as
 * "no data yet" would silently discard the backup.
 */
function openValidated(dbPath: string): Database {
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size === 0) {
    throw new Error('the database file is empty');
  }
  const db = openDatabase(dbPath);
  try {
    const verdict = String(queryOne(db, 'PRAGMA quick_check')?.quick_check ?? '');
    if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Foreign keys were effectively off for the whole session in older builds
 * (sql.js reset the pragma on every save), so deleting a run left its file rows behind, and deleted
 * mappings/jobs left dangling references. Clear those out once so enforcing
 * foreign keys again can't trip over them -- e.g. an undo of a run whose
 * mapping was deleted would otherwise fail with a constraint error.
 */
export function repairIntegrity(db: Database): void {
  transaction(db, () => {
    db.exec('DELETE FROM run_history_files WHERE run_id NOT IN (SELECT id FROM run_history)');
    db.exec('DELETE FROM filter_rules WHERE mapping_id NOT IN (SELECT id FROM mappings)');
    db.exec(
      'DELETE FROM job_steps WHERE job_id NOT IN (SELECT id FROM jobs) OR mapping_id NOT IN (SELECT id FROM mappings)'
    );
    db.exec('UPDATE mappings SET next_mapping_id = NULL WHERE next_mapping_id NOT IN (SELECT id FROM mappings)');
    db.exec('UPDATE run_history SET mapping_id = NULL WHERE mapping_id IS NOT NULL AND mapping_id NOT IN (SELECT id FROM mappings)');
    db.exec('UPDATE run_history SET job_id = NULL WHERE job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM jobs)');
    db.exec(
      'UPDATE run_history SET undone_by_run_id = NULL WHERE undone_by_run_id IS NOT NULL AND undone_by_run_id NOT IN (SELECT id FROM run_history)'
    );
    db.exec(
      'UPDATE run_history SET triggered_by_run_id = NULL WHERE triggered_by_run_id IS NOT NULL AND triggered_by_run_id NOT IN (SELECT id FROM run_history)'
    );
  });
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

/** Folds the -wal into the main file. Called on quit; harmless if it can't finish. */
export function flushDatabase(db: Database): void {
  checkpoint(db);
}
