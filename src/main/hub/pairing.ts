import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import type { Database } from '../database/sqlite';
import { queryAll, queryOne, run } from '../database/dbHelpers';
import { transaction } from '../database/sqlite';
import { createRemoteWorker, getWorkerTokenHash, WorkerRecord } from '../database/workers';

/**
 * Pairing a worker machine with the hub.
 *
 * The owner makes a one-time code on the hub (Settings > Machines, or `fileshuttle-server pair-code`)
 * and types it on the worker machine. The worker trades the code for a worker id and a long random
 * token. Only SHA-256 hashes are kept here: of the codes and of the tokens. A code lives 10
 * minutes, works once, and five wrong tries void every open code.
 */

/** No 0/O, 1/I/L: a code is read off one screen and typed on another. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_WRONG_CODE_TRIES = 5;
const MAX_OPEN_CODES = 5;
export const WORKER_TOKEN_PREFIX = 'fsw_';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Upper case, and spaces, dashes and look-alike typing slips removed, so "abcd-2345" matches "ABCD2345". */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

/** The code as shown to the owner: XXXX-XXXX. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface PairingCode {
  /** Shown once (XXXX-XXXX). Only its hash is stored. */
  code: string;
  expiresAt: string;
}

function purgeExpired(db: Database, nowIso: string): void {
  run(db, 'DELETE FROM worker_pairing_codes WHERE expires_at <= ?', [nowIso]);
}

/** Makes a code. Making one resets the wrong-try count. */
export function createPairingCode(db: Database, now: Date = new Date()): PairingCode {
  const nowIso = now.toISOString();
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS).toISOString();
  transaction(db, () => {
    purgeExpired(db, nowIso);
    // A few open codes at most: the oldest are dropped.
    const open = queryAll(db, 'SELECT code_hash FROM worker_pairing_codes ORDER BY created_at, code_hash');
    for (const row of open.slice(0, Math.max(0, open.length - (MAX_OPEN_CODES - 1)))) {
      run(db, 'DELETE FROM worker_pairing_codes WHERE code_hash = ?', [String(row.code_hash)]);
    }
    run(db, 'INSERT INTO worker_pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)', [
      sha256Hex(code),
      nowIso,
      expiresAt,
    ]);
    run(db, 'INSERT INTO worker_pairing_failures (id, failures) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET failures = 0');
  });
  return { code: formatCode(code), expiresAt };
}

/** How many codes are open right now (for tests and the UI). */
export function openCodeCount(db: Database, now: Date = new Date()): number {
  return Number(
    queryOne(db, 'SELECT COUNT(*) AS n FROM worker_pairing_codes WHERE expires_at > ?', [now.toISOString()])?.n ?? 0
  );
}

export function newWorkerToken(): string {
  return WORKER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export type RedeemResult =
  | { ok: true; worker: WorkerRecord; token: string }
  | { ok: false; message: string };

/** The one answer for a code that is wrong, expired or used: never says which. */
export const BAD_CODE_MESSAGE = 'That pairing code is not valid. Make a new one on the hub and try again.';

/**
 * Trades a code for a new paired machine. A wrong code counts against the limit; at five, every open
 * code is voided (the owner makes a new one). The answer never says whether a code existed.
 */
export function redeemPairingCode(
  db: Database,
  rawCode: string,
  info: { name: string; platform?: string | null },
  now: Date = new Date()
): RedeemResult {
  const nowIso = now.toISOString();
  return transaction(db, (): RedeemResult => {
    purgeExpired(db, nowIso);
    const normalized = normalizeCode(rawCode);
    const wellFormed = normalized.length === CODE_LENGTH && [...normalized].every((c) => CODE_ALPHABET.includes(c));
    const row = wellFormed
      ? queryOne(db, 'SELECT code_hash FROM worker_pairing_codes WHERE code_hash = ?', [sha256Hex(normalized)])
      : null;
    if (!row) {
      run(
        db,
        'INSERT INTO worker_pairing_failures (id, failures) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET failures = failures + 1'
      );
      const failures = Number(queryOne(db, 'SELECT failures FROM worker_pairing_failures WHERE id = 1')?.failures ?? 0);
      if (failures >= MAX_WRONG_CODE_TRIES) {
        run(db, 'DELETE FROM worker_pairing_codes');
        run(db, 'UPDATE worker_pairing_failures SET failures = 0 WHERE id = 1');
      }
      return { ok: false, message: BAD_CODE_MESSAGE };
    }
    run(db, 'DELETE FROM worker_pairing_codes WHERE code_hash = ?', [String(row.code_hash)]);
    run(db, 'UPDATE worker_pairing_failures SET failures = 0 WHERE id = 1');
    const token = newWorkerToken();
    const worker = createRemoteWorker(db, { name: info.name, tokenHash: sha256Hex(token), platform: info.platform }, nowIso);
    return { ok: true, worker, token };
  });
}

/** A fixed hash compared against when no real one exists, so an unknown id costs the same as a wrong token. */
const DUMMY_HASH = sha256Hex('no such worker');

/** True when `token` is the token of that paired machine. Constant-time, and the same work for an unknown id. */
export function verifyWorkerToken(db: Database, workerId: string, token: string): boolean {
  const stored = getWorkerTokenHash(db, workerId);
  const expected = Buffer.from(stored ?? DUMMY_HASH, 'hex');
  const given = Buffer.from(sha256Hex(token), 'hex');
  const equal = expected.length === given.length && timingSafeEqual(expected, given);
  return stored !== null && equal;
}
