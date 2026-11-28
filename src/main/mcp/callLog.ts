import * as fs from 'fs';

/** One JSON line per MCP call (and per refused request) in mcp-calls.log. Never holds a token. */

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ARGS_CHARS = 4000;

export interface CallLogEntry {
  event: 'tool-call' | 'auth-failed' | 'rejected';
  /** The token's name, never the token. */
  token: string | null;
  tool?: string;
  arguments?: unknown;
  result?: 'ok' | 'error' | 'needs-confirmation';
  reason?: string;
  durationMs?: number;
}

/** A copy of the arguments that is safe to keep: confirmation codes hidden, long values cut. */
export function redactArguments(args: unknown): unknown {
  let copy: unknown = args;
  if (args && typeof args === 'object' && !Array.isArray(args) && 'confirm' in args) {
    copy = { ...(args as Record<string, unknown>), confirm: '[redacted]' };
  }
  let text: string;
  try {
    text = JSON.stringify(copy) ?? 'null';
  } catch {
    return '[unserializable]';
  }
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…(cut)` : copy;
}

export class CallLog {
  constructor(
    private readonly getPath: () => string,
    private readonly now: () => Date = () => new Date(),
    private readonly maxBytes: number = MAX_LOG_BYTES
  ) {}

  /** Appends a line. Any failure is swallowed: logging must never break a call. */
  write(entry: CallLogEntry): void {
    try {
      const file = this.getPath();
      try {
        if (fs.statSync(file).size > this.maxBytes) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet, or it could not be rotated: keep appending */
      }
      fs.appendFileSync(file, JSON.stringify({ time: this.now().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch {
      /* ignored on purpose */
    }
  }
}
