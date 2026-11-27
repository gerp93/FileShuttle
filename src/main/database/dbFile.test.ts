import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import {
  backupPathFor,
  copyBeforeFirstNativeOpen,
  copyDatabaseFile,
  loadWithBackupFallback,
  preNativeCopyPathFor,
} from './dbFile';
import { queryAll, run } from './dbHelpers';
import { openDatabase, transaction } from './sqlite';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = makeTempDir('fileshuttle-dbfile-');
  dbPath = path.join(dir, 'fileshuttle.db');
});
afterEach(() => removeDir(dir));

const read = (p: string) => fs.readFileSync(p, 'utf8');
/** An `open` that accepts only files whose content starts with "GOOD". */
const openGood = (p: string) => {
  if (!fs.existsSync(p)) return 'fresh';
  const text = fs.readFileSync(p, 'utf8');
  if (!text.startsWith('GOOD')) throw new Error('not a database');
  return text;
};

describe('copyBeforeFirstNativeOpen', () => {
  it('does nothing when there is no database', () => {
    expect(copyBeforeFirstNativeOpen(dbPath)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('copies the database byte for byte and leaves no temp file', () => {
    fs.writeFileSync(dbPath, 'GOOD original');
    expect(copyBeforeFirstNativeOpen(dbPath)).toBe(true);
    expect(read(preNativeCopyPathFor(dbPath))).toBe('GOOD original');
    expect(fs.readdirSync(dir).sort()).toEqual(['fileshuttle.db', 'fileshuttle.db.pre-native-sqlite']);
  });

  it('never replaces a copy that already exists', () => {
    fs.writeFileSync(dbPath, 'GOOD v2');
    fs.writeFileSync(preNativeCopyPathFor(dbPath), 'GOOD v1');
    expect(copyBeforeFirstNativeOpen(dbPath)).toBe(false);
    expect(read(preNativeCopyPathFor(dbPath))).toBe('GOOD v1');
  });

  it('leaves no half copy under the final name when the copy fails', () => {
    // A directory where the copy's temp file should go makes the copy fail.
    fs.writeFileSync(dbPath, 'GOOD original');
    fs.mkdirSync(preNativeCopyPathFor(dbPath) + '.tmp');
    expect(() => copyBeforeFirstNativeOpen(dbPath)).toThrow();
    expect(fs.existsSync(preNativeCopyPathFor(dbPath))).toBe(false);
  });
});

describe('copyDatabaseFile (WAL)', () => {
  function seed() {
    const db = openDatabase(dbPath);
    db.exec('CREATE TABLE t (v TEXT)');
    db.exec("INSERT INTO t VALUES ('old')");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // Written after the checkpoint, so it lives only in the -wal sidecar.
    db.exec("INSERT INTO t VALUES ('just written')");
    return db;
  }
  const values = (p: string) => {
    const db = openDatabase(p);
    try {
      return queryAll(db, 'SELECT v FROM t ORDER BY rowid').map((r) => r.v);
    } finally {
      db.close();
    }
  };

  it('with the open connection, the copy contains a row written just before it', () => {
    const db = seed();
    expect(fs.statSync(dbPath + '-wal').size).toBeGreaterThan(0);
    const target = path.join(dir, 'moved', 'copy.db');
    fs.mkdirSync(path.dirname(target));
    copyDatabaseFile(dbPath, target, db);
    db.close();
    expect(values(target)).toEqual(['old', 'just written']);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['copy.db']);
  });

  it('a plain copy of only the main file would have missed that row', () => {
    const db = seed();
    const bare = path.join(dir, 'bare.db');
    fs.copyFileSync(dbPath, bare);
    db.close();
    expect(values(bare)).toEqual(['old']);
  });

  it('without a connection, the -wal sidecar is carried along', () => {
    const db = seed();
    const target = path.join(dir, 'copy.db');
    copyDatabaseFile(dbPath, target, null);
    db.close();
    expect(values(target)).toEqual(['old', 'just written']);
  });
});

describe('transaction', () => {
  it('commits on success, rolls back on error, and nests as savepoints', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    transaction(db, () => run(db, 'INSERT INTO t VALUES (1)'));
    expect(() =>
      transaction(db, () => {
        run(db, 'INSERT INTO t VALUES (2)');
        throw new Error('boom');
      })
    ).toThrow('boom');
    transaction(db, () => {
      run(db, 'INSERT INTO t VALUES (3)');
      expect(() =>
        transaction(db, () => {
          run(db, 'INSERT INTO t VALUES (4)');
          throw new Error('inner');
        })
      ).toThrow('inner');
    });
    expect(queryAll(db, 'SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1, 3]);
    db.close();
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
