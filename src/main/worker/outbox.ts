import * as fs from 'fs';
import * as path from 'path';
import type { WorkerToHub } from '../../shared/workerProtocol';

/**
 * A durable queue for what a remote worker must not lose: each finished run (with its per-file
 * rows) and each "job finished" note. An entry is written to its own file, flushed to disk, and
 * only then reported; it is deleted when the hub acknowledges it. On reconnect everything still
 * here is sent again, oldest first, and the hub stores each run_uid once, so a resend is harmless.
 *
 * Entries are never dropped for age or size: a worker that is offline for a month still reports
 * everything it did. A file that cannot be read is set aside (".bad") and left alone.
 */
export class Outbox {
  private readonly files = new Map<string, string>(); // id -> file name
  private seq = 0;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  /** Writes the entry (replacing one with the same id) before returning. */
  add(id: string, message: WorkerToHub): void {
    if (this.files.has(id)) return;
    const name = `${String(Date.now()).padStart(15, '0')}-${String(this.seq++).padStart(6, '0')}.json`;
    const final = path.join(this.dir, name);
    const temp = `${final}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ id, message }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, final);
    this.files.set(id, name);
  }

  /** Forgets an entry the hub has acknowledged. An unknown id is ignored. */
  remove(id: string): void {
    const name = this.files.get(id);
    if (!name) return;
    this.files.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, name));
    } catch {
      // Already gone: nothing to resend either way.
    }
  }

  /** What is still waiting for an acknowledgement, oldest first. */
  pending(): WorkerToHub[] {
    const out: WorkerToHub[] = [];
    for (const name of [...this.files.values()].sort()) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as { message: WorkerToHub };
        out.push(entry.message);
      } catch {
        // Checked again at the next start; skip for now.
      }
    }
    return out;
  }

  get size(): number {
    return this.files.size;
  }

  private load(): void {
    const names = fs.readdirSync(this.dir).sort();
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.endsWith('.tmp')) {
        // A write that never finished: it was never reported either.
        fs.rmSync(file, { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown; message?: unknown };
        if (typeof entry.id !== 'string' || typeof entry.message !== 'object' || entry.message === null) throw new Error('bad entry');
        this.files.set(entry.id, name);
      } catch {
        fs.renameSync(file, `${file}.bad`);
      }
    }
  }
}
