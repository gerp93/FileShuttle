import { randomInt } from 'crypto';

/**
 * One-time confirmation codes for destructive tools. The first call does nothing and gets a code;
 * the action happens only when the call is repeated with that code and the same arguments. A code
 * is bound to the token, the tool and the exact arguments, lives 5 minutes, works once, and a
 * handful of wrong guesses cancels it. Held in memory only.
 */

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
const MAX_WRONG_GUESSES = 3;
// No 0/O, 1/I/L: the user may read the code aloud or retype it.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface Pending {
  code: string;
  expiresAt: number;
  wrong: number;
}

export type ConfirmOutcome = 'ok' | 'wrong' | 'expired' | 'none';

/** Stable text for a set of arguments (sorted keys), without the confirm field. */
export function canonicalArguments(args: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)])
      );
    }
    return value;
  };
  const { confirm: _confirm, ...rest } = args;
  void _confirm;
  return JSON.stringify(sort(rest));
}

export class ConfirmationStore {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(token: string, tool: string, args: Record<string, unknown>): string {
    return `${token}\u0000${tool}\u0000${canonicalArguments(args)}`;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(k);
  }

  /** Makes (or replaces) the code for this exact action. */
  issue(token: string, tool: string, args: Record<string, unknown>): { code: string; expiresInMinutes: number } {
    this.prune();
    let code = '';
    for (let i = 0; i < 6; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
    this.pending.set(this.key(token, tool, args), { code, expiresAt: this.now() + CONFIRM_TTL_MS, wrong: 0 });
    return { code, expiresInMinutes: CONFIRM_TTL_MS / 60_000 };
  }

  /** Checks a code. 'ok' uses it up. Nothing but a match with the same arguments ever succeeds. */
  consume(token: string, tool: string, args: Record<string, unknown>, code: string): ConfirmOutcome {
    const k = this.key(token, tool, args);
    const p = this.pending.get(k);
    if (!p) return 'none';
    if (p.expiresAt <= this.now()) {
      this.pending.delete(k);
      return 'expired';
    }
    if (code.trim().toUpperCase() !== p.code) {
      p.wrong += 1;
      if (p.wrong >= MAX_WRONG_GUESSES) this.pending.delete(k);
      return 'wrong';
    }
    this.pending.delete(k);
    return 'ok';
  }
}
