import initSqlJs, { Database } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import { getEffectiveDbPath } from '../dbLocation';

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mappings (
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
    sort_order   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS run_history (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id             INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
    mapping_name_snapshot  TEXT NOT NULL,
    trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo')),
    started_at             TEXT NOT NULL,
    finished_at            TEXT NOT NULL,
    files_moved            INTEGER NOT NULL DEFAULT 0,
    files_copied           INTEGER NOT NULL DEFAULT 0,
    files_deleted          INTEGER NOT NULL DEFAULT 0,
    files_skipped          INTEGER NOT NULL DEFAULT 0,
    files_errored          INTEGER NOT NULL DEFAULT 0,
    status                 TEXT NOT NULL CHECK (status IN ('success','partial','error')),
    error_message          TEXT,
    undone_by_run_id       INTEGER REFERENCES run_history(id) ON DELETE SET NULL,
    triggered_by_run_id    INTEGER REFERENCES run_history(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_history_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    source_path     TEXT NOT NULL,
    dest_path       TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN ('moved','copied','deleted','skipped','error')),
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
                                 CHECK (schedule_type IN ('manual','interval','daily_at')),
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

function addColumnIfMissing(db: Database, table: string, column: string, ddl: string): void {
  const rows = db.exec(`PRAGMA table_info(${table})`);
  if (!rows.length) return;
  const existing = new Set(rows[0].values.map((row) => String(row[1])));
  if (!existing.has(column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function widenRunHistoryFilesOutcomeCheck(db: Database): void {
  const rows = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_history_files'");
  if (!rows.length || !rows[0].values.length) return;
  const sql = String(rows[0].values[0][0] ?? '');
  if (sql.includes("'copied'")) return;

  db.run('ALTER TABLE run_history_files RENAME TO run_history_files_old');
  db.run(`CREATE TABLE run_history_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
    source_path     TEXT NOT NULL,
    dest_path       TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN ('moved','copied','deleted','skipped','error')),
    reason          TEXT,
    file_size_bytes INTEGER
  )`);
  db.run(
    'INSERT INTO run_history_files (id, run_id, source_path, dest_path, outcome, reason, file_size_bytes) ' +
      'SELECT id, run_id, source_path, dest_path, outcome, reason, file_size_bytes FROM run_history_files_old'
  );
  db.run('DROP TABLE run_history_files_old');
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

function initSchema(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  for (const statement of STATEMENTS) {
    db.run(statement);
  }
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
  widenRunHistoryFilesOutcomeCheck(db);
  widenMappingsActionTypeCheck(db);
  addColumnIfMissing(db, 'mappings', 'keep_newest', 'keep_newest INTEGER');
  addColumnIfMissing(
    db,
    'run_history',
    'job_id',
    'job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL'
  );
  addColumnIfMissing(db, 'run_history', 'job_name_snapshot', 'job_name_snapshot TEXT');
}

export async function initDatabase(dbPath?: string): Promise<Database> {
  const SQL = await initSqlJs();
  dbPath = dbPath ?? getEffectiveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db: Database;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  dbInstance = db;
  currentDbPath = dbPath;
  initSchema(db);
  saveDatabase(db, dbPath);
  return db;
}

export function saveDatabase(db: Database, dbPath?: string): void {
  if (!dbPath) {
    dbPath = currentDbPath ?? getEffectiveDbPath();
  }
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function getDatabase(): Database | null {
  return dbInstance;
}

export function getCurrentDbPath(): string | null {
  return currentDbPath;
}
