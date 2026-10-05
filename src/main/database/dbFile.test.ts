import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import {
  backupPathFor,
  loadWithBackupFallback,
  refreshBackup,
  saveDatabaseFile,
  writeFileAtomic,
} from './dbFile';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = makeTempDir('fileshuttle-dbfile-');
  dbPath = path.join(dir, 'fileshuttle.db');
});
afterEach(() => removeDir(dir));

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (p: string) => fs.readFileSync(p, 'utf8');
/** An `open` that accepts only content starting with "GOOD". */
const openGood = (b: Uint8Array | null) => {
  if (!b) return 'fresh';
  const text = Buffer.from(b).toString('utf8');
  if (!text.startsWith('GOOD')) throw new Error('not a database');
  return text;
};

describe('writeFileAtomic', () => {
  it('creates the file and leaves no temp file behind', () => {
    writeFileAtomic(dbPath, bytes('one'));
    expect(read(dbPath)).toBe('one');
    expect(fs.readdirSync(dir)).toEqual(['fileshuttle.db']);
  });

  it('replaces existing content wholesale', () => {
    writeFileAtomic(dbPath, bytes('a much longer first version'));
    writeFileAtomic(dbPath, bytes('short'));
    expect(read(dbPath)).toBe('short');
  });

  it('leaves the original intact and cleans up when the replace fails', () => {
    // Renaming a file over a non-empty directory cannot succeed.
    fs.mkdirSync(dbPath);
    fs.writeFileSync(path.join(dbPath, 'keep.txt'), 'keep');
    expect(() => writeFileAtomic(dbPath, bytes('new'))).toThrow();
    expect(read(path.join(dbPath, 'keep.txt'))).toBe('keep');
    expect(fs.existsSync(dbPath + '.tmp')).toBe(false);
  });
});

describe('refreshBackup / saveDatabaseFile', () => {
  it('does nothing when there is no database yet', () => {
    expect(refreshBackup(dbPath, 0)).toBe(false);
    expect(fs.existsSync(backupPathFor(dbPath))).toBe(false);
  });

  it('backs up the previous version before it is overwritten', () => {
    saveDatabaseFile(dbPath, bytes('GOOD v1'), 0);
    saveDatabaseFile(dbPath, bytes('GOOD v2'), 0);
    expect(read(dbPath)).toBe('GOOD v2');
    expect(read(backupPathFor(dbPath))).toBe('GOOD v1');
  });

  it('does not re-copy a backup that is still fresh', () => {
    saveDatabaseFile(dbPath, bytes('GOOD v1'));
    saveDatabaseFile(dbPath, bytes('GOOD v2'));
    saveDatabaseFile(dbPath, bytes('GOOD v3'));
    // First save has nothing to back up; the second creates the backup of v1;
    // the third is inside the freshness window so the backup stays at v1.
    expect(read(backupPathFor(dbPath))).toBe('GOOD v1');
    expect(read(dbPath)).toBe('GOOD v3');
  });

  it('refreshes a stale backup', () => {
    saveDatabaseFile(dbPath, bytes('GOOD v1'), 0);
    saveDatabaseFile(dbPath, bytes('GOOD v2'), 0);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(backupPathFor(dbPath), old, old);
    saveDatabaseFile(dbPath, bytes('GOOD v3'));
    expect(read(backupPathFor(dbPath))).toBe('GOOD v2');
  });
});

describe('loadWithBackupFallback', () => {
  it('opens a fresh database when no file exists', () => {
    const result = loadWithBackupFallback(dbPath, openGood);
    expect(result).toEqual({ value: 'fresh', recoveredFromBackup: false, quarantinedTo: null });
  });

  it('opens a healthy file without touching the backup', () => {
    fs.writeFileSync(dbPath, 'GOOD main');
    fs.writeFileSync(backupPathFor(dbPath), 'GOOD backup');
    const result = loadWithBackupFallback(dbPath, openGood);
    expect(result.value).toBe('GOOD main');
    expect(result.recoveredFromBackup).toBe(false);
  });

  it('restores from the backup and quarantines the unreadable file', () => {
    fs.writeFileSync(dbPath, 'torn garbage');
    fs.writeFileSync(backupPathFor(dbPath), 'GOOD backup');
    const result = loadWithBackupFallback(dbPath, openGood);

    expect(result.value).toBe('GOOD backup');
    expect(result.recoveredFromBackup).toBe(true);
    expect(read(dbPath)).toBe('GOOD backup');
    expect(result.quarantinedTo).toBeTruthy();
    expect(read(result.quarantinedTo!)).toBe('torn garbage');
  });

  it('fails loudly, leaving the file untouched, when there is no backup', () => {
    fs.writeFileSync(dbPath, 'torn garbage');
    expect(() => loadWithBackupFallback(dbPath, openGood)).toThrow(/no backup/);
    expect(read(dbPath)).toBe('torn garbage');
  });

  it('fails loudly, leaving both files untouched, when the backup is bad too', () => {
    fs.writeFileSync(dbPath, 'torn garbage');
    fs.writeFileSync(backupPathFor(dbPath), 'also garbage');
    expect(() => loadWithBackupFallback(dbPath, openGood)).toThrow(/backup could not be opened/);
    expect(read(dbPath)).toBe('torn garbage');
    expect(read(backupPathFor(dbPath))).toBe('also garbage');
  });
});
