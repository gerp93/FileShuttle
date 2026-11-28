import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Database } from './sqlite';
import { transaction } from './sqlite';
import { queryAll, queryOne, run } from './dbHelpers';

/**
 * How a computer becomes a worker, and how it proves who it is afterwards.
 *
 *  1. The owner asks the hub for a PAIRING CODE for a named computer (`fileshuttle-server workers pair <name>`,
 *     or the desktop hub's Settings). The code is ten random characters, good for 15 minutes and for one use.
 *  2. The computer sends the code to the hub, which deletes it and answers with a WORKER TOKEN, once. The token
 *     is 32 random bytes; the hub keeps only its SHA-256 hash, so a copy of the database does not hold a usable one.
 *  3. Every later request carries the token. Revoking clears the hash: the next request (or the open connection)
 *     is refused at once. The computer's mappings, jobs and history stay, and a new code can re-pair it.
 *
 * Neither the code nor the token is ever written to a log by this module.
 */

export const PAIRING_TTL_MS = 15 * 60 * 1000;
export const WORKER_TOKEN_PREFIX = 'fsw_';
const NAME_PATTERN = /^[\w .@-]{1,60}$/;
/** Crockford base32 without I, L, O, U: nothing that can be misread when typed. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashWorkerToken(token: string): string {
  return sha256(token);
}

export function validateWorkerName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the computer a name.';
  if (!NAME_PATTERN.test(name.trim())) {
    return 'The name may use letters, digits, spaces and . _ @ - (at most 60 characters).';
  }
  return null;
}

/** Upper-cases, drops spaces and dashes and folds the look-alike letters, so "abcde-fghjk" and "ABCDEFGHJK" match. */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** "ABCDE-FGHJK": how a code is shown. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % 32];
  return out;
}

function nameTaken(db: Database, name: string, exceptWorkerId?: string): boolean {
  const worker = queryOne(db, 'SELECT id FROM workers WHERE name = ? COLLATE NOCASE', [name]);
  if (worker && String(worker.id) !== exceptWorkerId) return true;
  return !!queryOne(db, 'SELECT 1 AS x FROM worker_pairings WHERE name = ? AND worker_id IS NULL', [name]);
}

export interface Pairing {
  /** Shown to the owner once, as "ABCDE-FGHJK". */
  code: string;
  name: string;
  expiresAt: string;
  /** Set when the code re-pairs an existing worker. */
  workerId: string | null;
}

function purgeExpiredPairings(db: Database, nowIso: string): void {
  run(db, 'DELETE FROM worker_pairings WHERE expires_at <= ?', [nowIso]);
}

/**
 * Makes a one-time code for a new computer called `name`, or, when `workerId` is given, for an existing
 * remote worker whose token was revoked or lost (it keeps its name, mappings, jobs and history).
 */
export function createPairing(
  db: Database,
  input: { name?: string; workerId?: string },
  now: Date = new Date()
): Pairing {
  const nowIso = now.toISOString();
  return transaction(db, () => {
    purgeExpiredPairings(db, nowIso);
    let name: string;
    let workerId: string | null = null;
    if (input.workerId) {
      const worker = queryOne(db, "SELECT id, name, kind FROM workers WHERE id = ?", [input.workerId]);
      if (!worker || String(worker.kind) !== 'remote') throw new Error('There is no remote computer with that id.');
      name = String(worker.name);
      workerId = String(worker.id);
      // A newer code replaces an older unused one for the same computer.
      run(db, 'DELETE FROM worker_pairings WHERE worker_id = ?', [workerId]);
    } else {
      const problem = validateWorkerName(input.name);
      if (problem) throw new Error(problem);
      name = String(input.name).trim();
      if (nameTaken(db, name)) throw new Error(`There is already a computer named "${name}".`);
    }
    const code = newCode();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
    run(db, 'INSERT INTO worker_pairings (code_hash, name, worker_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
      sha256(code),
      name,
      workerId,
      nowIso,
      expiresAt,
    ]);
    return { code: formatPairingCode(code), name, expiresAt, workerId };
  });
}

export interface PendingPairing {
  name: string;
  workerId: string | null;
  expiresAt: string;
}

export function listPendingPairings(db: Database, now: Date = new Date()): PendingPairing[] {
  return queryAll(db, 'SELECT name, worker_id, expires_at FROM worker_pairings WHERE expires_at > ? ORDER BY created_at', [
    now.toISOString(),
  ]).map((row) => ({
    name: String(row.name),
    workerId: row.worker_id ? String(row.worker_id) : null,
    expiresAt: String(row.expires_at),
  }));
}

/** Withdraws the unused code(s) for a computer name. Returns whether there was one. */
export function cancelPairing(db: Database, name: string): boolean {
  const existing = queryOne(db, 'SELECT 1 AS x FROM worker_pairings WHERE name = ?', [name.trim()]);
  if (!existing) return false;
  run(db, 'DELETE FROM worker_pairings WHERE name = ?', [name.trim()]);
  return true;
}

export interface PairedWorker {
  workerId: string;
  name: string;
  /** Returned ONCE; only its hash is stored. */
  token: string;
}

/**
 * Exchanges a pairing code for a worker token. The code is consumed (a second try, or a wrong or expired
 * code, returns null). The caller rate-limits attempts: this does not.
 */
export function redeemPairing(db: Database, presentedCode: unknown, now: Date = new Date()): PairedWorker | null {
  if (typeof presentedCode !== 'string' || presentedCode.length === 0 || presentedCode.length > 64) return null;
  const normalized = normalizePairingCode(presentedCode);
  if (normalized.length !== CODE_LENGTH) return null;
  const candidate = Buffer.from(sha256(normalized), 'hex');
  const nowIso = now.toISOString();
  return transaction(db, () => {
    purgeExpiredPairings(db, nowIso);
    let match: { name: string; workerId: string | null; hash: string } | null = null;
    // Every stored hash is compared (no early exit), in constant time.
    for (const row of queryAll(db, 'SELECT code_hash, name, worker_id FROM worker_pairings')) {
      const stored = Buffer.from(String(row.code_hash), 'hex');
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        match = { name: String(row.name), workerId: row.worker_id ? String(row.worker_id) : null, hash: String(row.code_hash) };
      }
    }
    if (!match) return null;
    run(db, 'DELETE FROM worker_pairings WHERE code_hash = ?', [match.hash]);
    const token = WORKER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    if (match.workerId) {
      if (!queryOne(db, "SELECT 1 AS x FROM workers WHERE id = ? AND kind = 'remote'", [match.workerId])) return null;
      run(db, 'UPDATE workers SET token_hash = ? WHERE id = ?', [hashWorkerToken(token), match.workerId]);
      return { workerId: match.workerId, name: match.name, token };
    }
    const id = randomUUID();
    run(db, "INSERT INTO workers (id, name, kind, token_hash, created_at) VALUES (?, ?, 'remote', ?, ?)", [
      id,
      match.name,
      hashWorkerToken(token),
      nowIso,
    ]);
    return { workerId: id, name: match.name, token };
  });
}

export interface VerifiedWorker {
  workerId: string;
  name: string;
}

/** The remote worker whose token this is, or null (unknown, revoked, or not a token at all). */
export function verifyWorkerToken(db: Database, presented: unknown): VerifiedWorker | null {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return null;
  const candidate = Buffer.from(hashWorkerToken(presented), 'hex');
  let matched: VerifiedWorker | null = null;
  for (const row of queryAll(db, "SELECT id, name, token_hash FROM workers WHERE kind = 'remote' AND token_hash IS NOT NULL")) {
    const stored = Buffer.from(String(row.token_hash), 'hex');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
      matched = { workerId: String(row.id), name: String(row.name) };
    }
  }
  return matched;
}

/**
 * Cuts a remote worker off: its token stops working. Its mappings, jobs and history stay, and
 * a new pairing code can bring the computer back. `nameOrId` is matched against the name (any case) or the id.
 * Returns the worker's id, or null when there is no such remote worker.
 */
export function revokeWorkerToken(db: Database, nameOrId: string): string | null {
  const key = String(nameOrId).trim();
  const row = queryOne(
    db,
    "SELECT id FROM workers WHERE kind = 'remote' AND (id = ? OR name = ? COLLATE NOCASE)",
    [key, key]
  );
  if (!row) return null;
  run(db, 'UPDATE workers SET token_hash = NULL WHERE id = ?', [String(row.id)]);
  return String(row.id);
}

/** Finds a remote worker by name or id (for the command line). */
export function findRemoteWorkerId(db: Database, nameOrId: string): string | null {
  const key = String(nameOrId).trim();
  const row = queryOne(db, "SELECT id FROM workers WHERE kind = 'remote' AND (id = ? OR name = ? COLLATE NOCASE)", [key, key]);
  return row ? String(row.id) : null;
}
