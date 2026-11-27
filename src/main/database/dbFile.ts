import * as fs from 'fs';
import { Database } from './sqlite';

/**
 * File handling around the SQLite database file.
 *
 * Until the switch to node:sqlite, the app kept the whole database in memory and
 * rewrote the file on every save (sql.js). The first time the native driver opens an
 * existing file it may change it (WAL mode, migrations), so a copy is made first,
 * beside the original, and never deleted by the app.
 *
 * The database now runs in WAL mode: recent commits can sit in the -wal sidecar, so
 * anything that copies the file must go through `copyDatabaseFile` (VACUUM INTO of the
 * open database) or copy the sidecar too.
 */

/** The copy made before the native driver first touches an existing database. */
export const PRE_NATIVE_SUFFIX = '.pre-native-sqlite';
/** The rolling backup the sql.js build kept; still used to recover an unreadable file. */
export const BACKUP_SUFFIX = '.bak';
const TMP_SUFFIX = '.tmp';
const RENAME_RETRIES = 5;

/** The copy made before the workers migration first changes the database. */
export const PRE_WORKERS_SUFFIX = '.pre-workers';

export function preWorkersCopyPathFor(dbPath: string): string {
  return dbPath + PRE_WORKERS_SUFFIX;
}

export function preNativeCopyPathFor(dbPath: string): string {
  return dbPath + PRE_NATIVE_SUFFIX;
}

export function backupPathFor(dbPath: string): string {
  return dbPath + BACKUP_SUFFIX;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * On Windows a rename over an existing file can fail transiently with
 * EPERM/EBUSY/EACCES while antivirus or an indexer briefly holds the target.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= RENAME_RETRIES) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
}

/** Copies via a temp name and renames, so a crash never leaves a half copy under `to`. */
function copyFileAtomic(from: string, to: string): void {
  const tmp = to + TMP_SUFFIX;
  try {
    fs.copyFileSync(from, tmp);
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, to);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Makes `<db>.pre-native-sqlite` from the existing file, but only when the database
 * exists and that copy does not. Returns true when a copy was made. The app never
 * deletes it. A leftover -wal (only possible if a native build already ran) goes with it.
 */
export function copyBeforeFirstNativeOpen(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const copyPath = preNativeCopyPathFor(dbPath);
  if (fs.existsSync(copyPath)) return false;
  const wal = dbPath + '-wal';
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    copyFileAtomic(wal, copyPath + '-wal');
  }
  copyFileAtomic(dbPath, copyPath);
  return true;
}

/**
 * Copies a database to `to` (which must not exist), including recent commits that
 * are still in the -wal. With the open `db` it uses VACUUM INTO, which writes a
 * consistent single file; without one it copies the file and its -wal sidecar.
 */
export function copyDatabaseFile(from: string, to: string, db?: Database | null): void {
  if (db) {
    const tmp = to + TMP_SUFFIX;
    fs.rmSync(tmp, { force: true });
    try {
      db.prepare('VACUUM INTO ?').run(tmp);
      renameWithRetry(tmp, to);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return;
  }
  const wal = from + '-wal';
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    copyFileAtomic(wal, to + '-wal');
  }
  copyFileAtomic(from, to);
}

/**
 * Makes `<db>.pre-workers` from the open database, for the one-time move to the hub/worker
 * data model. Never overwrites an existing copy and never deletes one. It goes through a temp
 * name and a rename (via `copyDatabaseFile`), so a crash never leaves a half copy under the
 * final name, and VACUUM INTO includes anything still in the -wal. Returns true when made.
 */
export function copyBeforeWorkersMigration(dbPath: string, db: Database): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const copyPath = preWorkersCopyPathFor(dbPath);
  if (fs.existsSync(copyPath)) return false;
  copyDatabaseFile(dbPath, copyPath, db);
  return true;
}

export interface LoadResult<T> {
  value: T;
  recoveredFromBackup: boolean;
  /** Where the unreadable original was moved to (kept for forensics, never deleted). */
  quarantinedTo: string | null;
}

/**
 * Opens <db>; if it is present but unreadable, falls back to a <db>.bak left by the
 * sql.js build. `open` receives the path to open and must throw if it is not a usable
 * database. A missing file is opened as-is (a fresh install creates it).
 *
 * Nothing is ever deleted here: an unreadable file is renamed aside, and if
 * no usable copy exists the original is left exactly as it was.
 */
export function loadWithBackupFallback<T>(dbPath: string, open: (path: string) => T): LoadResult<T> {
  if (!fs.existsSync(dbPath)) {
    return { value: open(dbPath), recoveredFromBackup: false, quarantinedTo: null };
  }

  let mainError: unknown;
  try {
    return { value: open(dbPath), recoveredFromBackup: false, quarantinedTo: null };
  } catch (err) {
    mainError = err;
  }

  const backupPath = backupPathFor(dbPath);
  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
  if (!fs.existsSync(backupPath)) {
    throw new Error(
      `The FileShuttle database at ${dbPath} could not be opened (${describe(mainError)}) and there is no backup to restore. The file has been left untouched.`
    );
  }

  // Try the backup in a scratch copy first so a bad backup is never promoted.
  const scratch = `${dbPath}.restore-check`;
  fs.rmSync(scratch, { force: true });
  copyFileAtomic(backupPath, scratch);
  try {
    const probe = open(scratch) as unknown as { close?: () => void };
    probe.close?.();
  } catch (backupError) {
    fs.rmSync(scratch, { force: true });
    throw new Error(
      `The FileShuttle database at ${dbPath} could not be opened (${describe(mainError)}), and its backup could not be opened either (${describe(backupError)}). Both files have been left untouched.`
    );
  }
  fs.rmSync(scratch, { force: true });
  fs.rmSync(scratch + '-wal', { force: true });
  fs.rmSync(scratch + '-shm', { force: true });

  const quarantinedTo = `${dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameWithRetry(dbPath, quarantinedTo);
  for (const side of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + side)) renameWithRetry(dbPath + side, quarantinedTo + side);
  }
  copyFileAtomic(backupPath, dbPath);
  return { value: open(dbPath), recoveredFromBackup: true, quarantinedTo };
}
