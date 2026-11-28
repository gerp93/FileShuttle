import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from './sqlite';
import { queryAll } from './dbHelpers';
import { initDatabase } from './schema';
import { getWorker, listWorkers } from './workers';
import {
  cancelPairing,
  createPairing,
  formatPairingCode,
  listPendingPairings,
  normalizePairingCode,
  PAIRING_TTL_MS,
  redeemPairing,
  revokeWorkerToken,
  verifyWorkerToken,
  WORKER_TOKEN_PREFIX,
} from './workerAccess';
import { makeTempDir, removeDir } from '../engine/testUtils';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-access-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
});
afterEach(() => {
  db.close();
  removeDir(root);
});

describe('pairing codes', () => {
  it('makes a one-time code that is good for 15 minutes and holds only its hash', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const pairing = createPairing(db, { name: 'KVG PC' }, now);
    expect(pairing.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(pairing.expiresAt).toBe(new Date(now.getTime() + PAIRING_TTL_MS).toISOString());

    const stored = JSON.stringify(queryAll(db, 'SELECT * FROM worker_pairings'));
    expect(stored).not.toContain(pairing.code);
    expect(stored).not.toContain(normalizePairingCode(pairing.code));
    expect(listPendingPairings(db, now)).toEqual([{ name: 'KVG PC', workerId: null, expiresAt: pairing.expiresAt }]);
  });

  it('is redeemed once: the second try, a wrong code and an expired code all fail', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    const pairing = createPairing(db, { name: 'KVG PC' }, now);

    expect(redeemPairing(db, 'AAAAA-AAAAA', now)).toBeNull();
    expect(redeemPairing(db, '', now)).toBeNull();
    expect(redeemPairing(db, 42, now)).toBeNull();
    const paired = redeemPairing(db, pairing.code, new Date(now.getTime() + 60_000));
    expect(paired).toMatchObject({ name: 'KVG PC' });
    expect(paired!.token.startsWith(WORKER_TOKEN_PREFIX)).toBe(true);
    expect(redeemPairing(db, pairing.code, new Date(now.getTime() + 61_000))).toBeNull();

    const late = createPairing(db, { name: 'Late' }, now);
    expect(redeemPairing(db, late.code, new Date(now.getTime() + PAIRING_TTL_MS + 1))).toBeNull();
    expect(listPendingPairings(db, new Date(now.getTime() + PAIRING_TTL_MS + 1))).toEqual([]);
  });

  it('reads a code however it was typed', () => {
    const pairing = createPairing(db, { name: 'Typed' });
    const sloppy = ` ${formatPairingCode(normalizePairingCode(pairing.code)).toLowerCase().replace('-', ' - ')} `;
    expect(redeemPairing(db, sloppy)).toMatchObject({ name: 'Typed' });
  });

  it('refuses a bad or repeated name', () => {
    expect(() => createPairing(db, { name: '' })).toThrow(/name/);
    expect(() => createPairing(db, { name: 'no/slashes' })).toThrow(/letters/);
    createPairing(db, { name: 'PC' });
    expect(() => createPairing(db, { name: 'pc' })).toThrow(/already/);
    const local = listWorkers(db)[0];
    expect(() => createPairing(db, { name: local.name.toUpperCase() })).toThrow(/already/);
  });

  it('can be withdrawn', () => {
    const pairing = createPairing(db, { name: 'PC' });
    expect(cancelPairing(db, 'PC')).toBe(true);
    expect(redeemPairing(db, pairing.code)).toBeNull();
    expect(cancelPairing(db, 'PC')).toBe(false);
  });
});

describe('worker tokens', () => {
  it('create a remote worker, are stored only as a hash and verify to that worker', () => {
    const paired = redeemPairing(db, createPairing(db, { name: 'KVG PC' }).code)!;
    const worker = getWorker(db, paired.workerId)!;
    expect(worker).toMatchObject({ kind: 'remote', name: 'KVG PC', hasToken: true });
    expect(JSON.stringify(queryAll(db, 'SELECT * FROM workers'))).not.toContain(paired.token);

    expect(verifyWorkerToken(db, paired.token)).toEqual({ workerId: paired.workerId, name: 'KVG PC' });
    expect(verifyWorkerToken(db, paired.token + 'x')).toBeNull();
    expect(verifyWorkerToken(db, '')).toBeNull();
    expect(verifyWorkerToken(db, undefined)).toBeNull();
  });

  it('give two computers two different tokens that each only open their own door', () => {
    const a = redeemPairing(db, createPairing(db, { name: 'A' }).code)!;
    const b = redeemPairing(db, createPairing(db, { name: 'B' }).code)!;
    expect(a.token).not.toBe(b.token);
    expect(verifyWorkerToken(db, a.token)!.workerId).toBe(a.workerId);
    expect(verifyWorkerToken(db, b.token)!.workerId).toBe(b.workerId);
  });

  it('stop working the moment they are revoked, and a new code brings the same worker back', () => {
    const paired = redeemPairing(db, createPairing(db, { name: 'KVG PC' }).code)!;
    expect(revokeWorkerToken(db, 'kvg pc')).toBe(paired.workerId);
    expect(verifyWorkerToken(db, paired.token)).toBeNull();
    expect(getWorker(db, paired.workerId)).toMatchObject({ kind: 'remote', hasToken: false });
    expect(revokeWorkerToken(db, 'nobody')).toBeNull();

    const again = redeemPairing(db, createPairing(db, { workerId: paired.workerId }).code)!;
    expect(again.workerId).toBe(paired.workerId);
    expect(again.token).not.toBe(paired.token);
    expect(verifyWorkerToken(db, paired.token)).toBeNull(); // the old one stays dead
    expect(verifyWorkerToken(db, again.token)).toMatchObject({ workerId: paired.workerId });
  });

  it('are not a way into the local worker', () => {
    const local = listWorkers(db).find((w) => w.kind === 'local')!;
    expect(() => createPairing(db, { workerId: local.id })).toThrow(/remote/);
    expect(revokeWorkerToken(db, local.name)).toBeNull();
  });
});
