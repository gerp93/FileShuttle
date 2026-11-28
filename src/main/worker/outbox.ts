import * as fs from 'fs';
import * as path from 'path';
import type { WorkerToHub } from '../../shared/workerProtocol';

/**
 * The worker's outbox: the reports that must not be lost (a finished step, a finished job, the answer
 * to a run or undo) wait here, on disk, until the hub has taken them, and survive a restart of the
 * worker. One JSON object per line: `{"seq":N,"message":{...}}`, `seq` counting up for ever.
 *
 * Delivery is at-least-once and in order: a batch is deleted only after the hub said it took it, so
 * a crash or a lost answer re-sends it, and the hub stores each step once by its `runUid`. The
 * file is rewritten (to a temp file, then renamed) when entries are removed; a torn last line from a
 * crash is skipped on load.
 */

export interface OutboxEntry {
  seq: number;
  message: WorkerToHub;
}

export interface OutboxOptions {
  /** Entries kept at most; the oldest are dropped beyond that (a computer unreachable for months). */
  maxEntries?: number;
  onDropped?: (count: number) => void;
}

export const DEFAULT_OUTBOX_MAX_ENTRIES = 20_000;

export class Outbox {
  private entries: OutboxEntry[] = [];
  private nextSeq = 1;
  private readonly maxEntries: number;

  constructor(
    private readonly file: string,
    private readonly opts: OutboxOptions = {}
  ) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_OUTBOX_MAX_ENTRIES;
    this.load();
  }

  private load(): void {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as OutboxEntry;
        if (typeof entry.seq !== 'number' || !entry.message || typeof entry.message.type !== 'string') continue;
        this.entries.push(entry);
        this.nextSeq = Math.max(this.nextSeq, entry.seq + 1);
      } catch {
        /* a torn line from a crash */
      }
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Adds a report. Returns its sequence number. */
  append(message: WorkerToHub): number {
    const entry: OutboxEntry = { seq: this.nextSeq++, message };
    this.entries.push(entry);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (this.entries.length > this.maxEntries) {
      const drop = this.entries.length - this.maxEntries;
      this.entries.splice(0, drop);
      this.rewrite();
      this.opts.onDropped?.(drop);
    }
    return entry.seq;
  }

  /** The oldest `limit` entries, still in the outbox. */
  peek(limit: number): OutboxEntry[] {
    return this.entries.slice(0, limit);
  }

  /** Removes every entry up to and including `seq` (the hub has them). */
  ackThrough(seq: number): void {
    const keep = this.entries.filter((entry) => entry.seq > seq);
    if (keep.length === this.entries.length) return;
    this.entries = keep;
    this.rewrite();
  }

  private rewrite(): void {
    if (this.entries.length === 0) {
      try {
        fs.writeFileSync(this.file, '', { mode: 0o600 });
      } catch {
        /* the next append writes the file anew */
      }
      return;
    }
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
