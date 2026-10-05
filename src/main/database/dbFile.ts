import * as fs from 'fs';

/**
 * Crash-safe persistence for the sql.js database file.
 *
 * sql.js holds the whole database in memory and we write the entire thing out
 * on every save. A plain writeFileSync truncates the file first, so a crash,
 * power cut, or full disk mid-write leaves a torn (or empty) database --
 * which then fails to open on the next launch. Instead:
 *
 *   1. write the new bytes to <db>.tmp and fsync it
 *   2. rename it over <db> (atomic replace on the same volume)
 *
 * and keep a rolling <db>.bak so a database that is somehow still unreadable
 * can be recovered automatically on startup.
 */

export const BACKUP_SUFFIX = '.bak';
const TMP_SUFFIX = '.tmp';
const DEFAULT_BACKUP_MIN_AGE_MS = 5 * 60 * 1000;
const RENAME_RETRIES = 5;

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

export function writeFileAtomic(filePath: string, data: Uint8Array): void {
  const tmpPath = filePath + TMP_SUFFIX;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  try {
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Copies the current database to <db>.bak, but at most once per `minAgeMs` --
 * saves happen on every edit, and re-copying a large history file each time
 * would be wasteful. Only call this while <db> is known to be good.
 */
export function refreshBackup(dbPath: string, minAgeMs = DEFAULT_BACKUP_MIN_AGE_MS): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const backupPath = backupPathFor(dbPath);
  if (fs.existsSync(backupPath) && Date.now() - fs.statSync(backupPath).mtimeMs < minAgeMs) {
    return false;
  }
  writeFileAtomic(backupPath, fs.readFileSync(dbPath));
  return true;
}

export function saveDatabaseFile(dbPath: string, data: Uint8Array, backupMinAgeMs?: number): void {
  refreshBackup(dbPath, backupMinAgeMs);
  writeFileAtomic(dbPath, data);
}

export interface LoadResult<T> {
  value: T;
  recoveredFromBackup: boolean;
  /** Where the unreadable original was moved to (kept for forensics, never deleted). */
  quarantinedTo: string | null;
}

/**
 * Opens <db>; if it is present but unreadable, falls back to <db>.bak.
 * `open` receives null when there is no file yet (a fresh install) and must
 * throw if the bytes are not a usable database.
 *
 * Nothing is ever deleted here: an unreadable file is renamed aside, and if
 * no usable copy exists the original is left exactly as it was.
 */
export function loadWithBackupFallback<T>(
  dbPath: string,
  open: (bytes: Uint8Array | null) => T
): LoadResult<T> {
  if (!fs.existsSync(dbPath)) {
    return { value: open(null), recoveredFromBackup: false, quarantinedTo: null };
  }

  let mainError: unknown;
  try {
    return { value: open(fs.readFileSync(dbPath)), recoveredFromBackup: false, quarantinedTo: null };
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

  let value: T;
  try {
    value = open(fs.readFileSync(backupPath));
  } catch (backupError) {
    throw new Error(
      `The FileShuttle database at ${dbPath} could not be opened (${describe(mainError)}), and its backup could not be opened either (${describe(backupError)}). Both files have been left untouched.`
    );
  }

  const quarantinedTo = `${dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameWithRetry(dbPath, quarantinedTo);
  writeFileAtomic(dbPath, fs.readFileSync(backupPath));
  return { value, recoveredFromBackup: true, quarantinedTo };
}
