import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryAll } from '../database/dbHelpers';
import { initDatabase } from '../database/schema';
import type { Database } from '../database/sqlite';
import { createRemoteWorker, getWorkerTokenHash, listWorkers, revokeWorker } from '../database/workers';
import { makeTempDir, removeDir } from '../engine/testUtils';
import {
  BAD_CODE_MESSAGE,
  CODE_ALPHABET,
  CODE_LIFETIME_MS,
  createPairingCode,
  normalizeCode,
  redeemPairingCode,
  sha256Hex,
  verifyWorkerToken,
} from './pairing';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;
beforeEach(async () => {
  root = makeTempDir('fileshuttle-pairing-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
});
afterEach(() => {
  db.close();
  removeDir(root);
});

const info = { name: 'Office PC', platform: 'win32' };

describe('pairing codes', () => {
  it('are 8 characters from an alphabet with no look-alikes, shown as XXXX-XXXX', () => {
    for (let i = 0; i < 20; i++) {
      const { code } = createPairingCode(db);
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of code.replace('-', '')) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('keep only a hash, and expire after 10 minutes', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const { code, expiresAt } = createPairingCode(db, now);
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(CODE_LIFETIME_MS);
    const stored = JSON.stringify(queryAll(db, 'SELECT * FROM worker_pairing_codes'));
    expect(stored).not.toContain(normalizeCode(code));
    expect(stored).toContain(sha256Hex(normalizeCode(code)));

    const late = new Date(now.getTime() + CODE_LIFETIME_MS + 1000);
    expect(redeemPairingCode(db, code, info, late)).toEqual({ ok: false, message: BAD_CODE_MESSAGE });
    expect(listWorkers(db)).toHaveLength(1); // only the local worker
  });

  it('work once, however the person typed them', () => {
    const { code } = createPairingCode(db);
    const typed = code.toLowerCase().replace('-', ' ');
    const first = redeemPairingCode(db, typed, info);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.token).toMatch(/^fsw_/);
    expect(first.worker).toMatchObject({ kind: 'remote', name: 'Office PC', platform: 'win32' });
    // The token itself is never stored: only its hash.
    expect(getWorkerTokenHash(db, first.worker.id)).toBe(sha256Hex(first.token));
    expect(JSON.stringify(queryAll(db, 'SELECT * FROM workers'))).not.toContain(first.token);
    expect(redeemPairingCode(db, code, info)).toEqual({ ok: false, message: BAD_CODE_MESSAGE });
  });

  it('five wrong tries void every open code', () => {
    const a = createPairingCode(db);
    const b = createPairingCode(db);
    for (let i = 0; i < 4; i++) expect(redeemPairingCode(db, 'WRONG-COD', info).ok).toBe(false);
    // Still good after four.
    const stillGood = redeemPairingCode(db, 'AAAA-AAAA'.replace(/A/g, 'B'), info);
    expect(stillGood.ok).toBe(false); // that was the fifth wrong try: all open codes are now gone
    expect(redeemPairingCode(db, a.code, info).ok).toBe(false);
    expect(redeemPairingCode(db, b.code, info).ok).toBe(false);
    // A fresh code works again.
    expect(redeemPairingCode(db, createPairingCode(db).code, info).ok).toBe(true);
  });

  it('a right code resets the wrong-try count', () => {
    for (let i = 0; i < 3; i++) redeemPairingCode(db, 'WRONG-COD', info);
    expect(redeemPairingCode(db, createPairingCode(db).code, info).ok).toBe(true);
    const keep = createPairingCode(db);
    for (let i = 0; i < 3; i++) redeemPairingCode(db, 'WRONG-COD', info);
    expect(redeemPairingCode(db, keep.code, info).ok).toBe(true);
  });

  it('keeps names unique', () => {
    const one = createRemoteWorker(db, { name: 'Laptop', tokenHash: sha256Hex('a') }, new Date().toISOString());
    const two = createRemoteWorker(db, { name: 'laptop', tokenHash: sha256Hex('b') }, new Date().toISOString());
    expect(one.name).toBe('Laptop');
    expect(two.name).toBe('laptop (2)');
  });
});

describe('worker tokens', () => {
  it('are accepted only for their own machine, and stop working when it is removed', () => {
    const { code } = createPairingCode(db);
    const made = redeemPairingCode(db, code, info);
    if (!made.ok) throw new Error('pairing failed');
    expect(verifyWorkerToken(db, made.worker.id, made.token)).toBe(true);
    expect(verifyWorkerToken(db, made.worker.id, `${made.token}x`)).toBe(false);
    expect(verifyWorkerToken(db, made.worker.id, '')).toBe(false);
    expect(verifyWorkerToken(db, 'no-such-worker', made.token)).toBe(false);
    revokeWorker(db, made.worker.id, new Date().toISOString());
    expect(verifyWorkerToken(db, made.worker.id, made.token)).toBe(false);
    expect(getWorkerTokenHash(db, made.worker.id)).toBeNull();
    expect(listWorkers(db).map((w) => w.id)).not.toContain(made.worker.id);
  });
});
