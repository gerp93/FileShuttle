/**
 * The one place the SQLite driver is named. Everything else imports `Database`,
 * `openDatabase` and friends from here, so swapping drivers touches this file only.
 *
 * The driver is node:sqlite (built into Node 22+ and Electron 44): writes go
 * straight to disk, there is no whole-file export, and no native module to rebuild.
 */
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

export type Database = DatabaseSyncType;
export type SqlValue = null | number | string | Uint8Array | bigint | boolean | undefined;

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/**
 * node:sqlite prints an ExperimentalWarning the first time it is loaded. Drop that one
 * warning (and only that one) while loading; every other warning still goes through.
 */
function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    const type = typeof args[0] === 'string' ? args[0] : (args[0] as { type?: string } | undefined)?.type;
    const name = typeof warning === 'string' ? type : warning?.name;
    if (name === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...args);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = require('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

/**
 * Opens (creating if needed) the database at `location` -- a file path or ':memory:' --
 * in WAL mode with foreign keys enforced. Numbers come back as numbers (no BigInt).
 */
export function openDatabase(location: string): Database {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(location);
  try {
    if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** node:sqlite rejects booleans and undefined; sql.js turned them into 1/0 and NULL. */
export function toSqlParam(value: SqlValue): null | number | string | Uint8Array | bigint {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

const depth = new WeakMap<Database, number>();

/**
 * Runs `fn` as one atomic write: committed if it returns, rolled back if it throws.
 * Re-entrant: a nested call becomes a savepoint inside the outer transaction.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `fs_sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    depth.set(db, level);
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    depth.set(db, level);
    try {
      db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      // The failure that matters is the original one.
    }
    throw err;
  }
}

/** Folds the -wal sidecar into the main file (best effort), e.g. before the file is copied. */
export function checkpoint(db: Database): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // A busy checkpoint only means the -wal stays; nothing is lost.
  }
}
