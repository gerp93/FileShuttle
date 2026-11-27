import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryAll } from './database/dbHelpers';
import { openDatabase } from './database/sqlite';
import { makeTempDir, removeDir } from './engine/testUtils';

let userData: string;
vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, setPath: () => undefined },
}));

import { setDbPath } from './dbLocation';

beforeEach(() => {
  userData = makeTempDir('fileshuttle-loc-');
});
afterEach(() => removeDir(userData));

describe('setDbPath (relocating the database)', () => {
  it('carries a row written just before the move, which is still in the -wal', () => {
    const current = path.join(userData, 'fileshuttle.db');
    const db = openDatabase(current);
    db.exec('CREATE TABLE t (v TEXT)');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec("INSERT INTO t VALUES ('just written')");
    expect(fs.statSync(current + '-wal').size).toBeGreaterThan(0);

    const target = path.join(userData, 'elsewhere', 'fileshuttle.db');
    setDbPath(target, db);
    db.close();

    const moved = openDatabase(target);
    try {
      expect(queryAll(moved, 'SELECT v FROM t').map((r) => r.v)).toEqual(['just written']);
    } finally {
      moved.close();
    }
  });
});
