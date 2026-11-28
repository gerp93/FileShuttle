import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Database } from '../database/sqlite';
import { queryAll, queryOne, run } from '../database/dbHelpers';
import type { McpTokenInfo } from '../../shared/types';

/**
 * MCP access tokens. The owner makes them (Settings on the PC, or `fileshuttle-server mcp-token`);
 * only a SHA-256 hash is stored, so a copy of the database does not hold a usable token. A token is
 * 32 random bytes, so a plain hash is enough (nothing to guess, nothing to slow down).
 */

export const TOKEN_PREFIX = 'fsm_';
const NAME_PATTERN = /^[\w .@-]{1,60}$/;
const LAST_USED_EVERY_MS = 60_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function validateTokenName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the token a name.';
  if (!NAME_PATTERN.test(name.trim())) {
    return 'The name may use letters, digits, spaces and . _ @ - (at most 60 characters).';
  }
  return null;
}

/** Makes a token and stores its hash. Returns the token ONCE; it can never be read back. */
export function createMcpToken(db: Database, name: string, now: Date = new Date()): { name: string; token: string } {
  const problem = validateTokenName(name);
  if (problem) throw new Error(problem);
  const clean = name.trim();
  if (queryOne(db, 'SELECT 1 AS x FROM mcp_tokens WHERE name = ?', [clean])) {
    throw new Error(`There is already a token named "${clean}".`);
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  run(db, 'INSERT INTO mcp_tokens (name, token_hash, created_at) VALUES (?, ?, ?)', [
    clean,
    hashToken(token),
    now.toISOString(),
  ]);
  return { name: clean, token };
}

export function listMcpTokens(db: Database): McpTokenInfo[] {
  return queryAll(db, 'SELECT name, created_at, last_used_at FROM mcp_tokens ORDER BY created_at, name').map((row) => ({
    name: String(row.name),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
  }));
}

/** Removes a token by name. Returns whether one existed. */
export function revokeMcpToken(db: Database, name: string): boolean {
  const existing = queryOne(db, 'SELECT 1 AS x FROM mcp_tokens WHERE name = ?', [String(name).trim()]);
  if (!existing) return false;
  run(db, 'DELETE FROM mcp_tokens WHERE name = ?', [String(name).trim()]);
  return true;
}

export function hasMcpTokens(db: Database): boolean {
  return !!queryOne(db, 'SELECT 1 AS x FROM mcp_tokens LIMIT 1');
}

const touchedByDb = new WeakMap<object, Map<string, number>>();

/**
 * The name of the token that matches, or null. Every stored hash is compared in constant time (no
 * early exit on the first match), and the last-used time is written at most once a minute per token.
 */
export function verifyMcpToken(db: Database, presented: string, now: () => number = Date.now): string | null {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return null;
  const candidate = Buffer.from(hashToken(presented), 'hex');
  let matched: string | null = null;
  for (const row of queryAll(db, 'SELECT name, token_hash FROM mcp_tokens')) {
    const stored = Buffer.from(String(row.token_hash), 'hex');
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) matched = String(row.name);
  }
  if (matched) {
    const key = matched.toLowerCase();
    let lastTouched = touchedByDb.get(db);
    if (!lastTouched) {
      lastTouched = new Map();
      touchedByDb.set(db, lastTouched);
    }
    const t = now();
    if (t - (lastTouched.get(key) ?? 0) >= LAST_USED_EVERY_MS) {
      lastTouched.set(key, t);
      try {
        run(db, 'UPDATE mcp_tokens SET last_used_at = ? WHERE name = ?', [new Date(t).toISOString(), matched]);
      } catch {
        /* a failed bookkeeping write never blocks a call */
      }
    }
  }
  return matched;
}
