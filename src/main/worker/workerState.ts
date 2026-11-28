import * as fs from 'fs';
import * as path from 'path';
import type { ScheduleSnapshot, WorkerRunSettings } from '../../shared/workerProtocol';

/**
 * What a remote worker keeps on its own computer, in one folder (`<data dir>/worker`):
 *
 *   worker.json    which hub it is paired with, its id and its TOKEN (a secret)
 *   schedule.json  the last schedule the hub sent, so schedules keep firing while the hub is
 *                  unreachable and after a restart
 *   outbox.jsonl   reports waiting to be delivered (see outbox.ts)
 *
 * The token is a secret, so worker.json is only readable by the user that runs the worker (mode 0600
 * in a 0700 folder). Where the platform offers a protected store the caller passes `protect` and the
 * token is stored encrypted with it (the desktop app passes Electron's `safeStorage`: DPAPI on Windows,
 * Keychain on macOS, the keyring on Linux). The token is never put in a log line or an error message.
 */

export interface WorkerIdentity {
  hubUrl: string;
  workerId: string;
  name: string;
  token: string;
}

export interface TokenProtection {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export interface CachedSchedule {
  version: number;
  schedule: ScheduleSnapshot;
  runSettings?: WorkerRunSettings;
}

const PROTECTED_PREFIX = 'protected:';

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export class WorkerStateStore {
  constructor(
    readonly dir: string,
    private readonly protection?: TokenProtection
  ) {}

  get identityFile(): string {
    return path.join(this.dir, 'worker.json');
  }
  get scheduleFile(): string {
    return path.join(this.dir, 'schedule.json');
  }
  get outboxFile(): string {
    return path.join(this.dir, 'outbox.jsonl');
  }

  /** The stored identity, or null when this computer is not paired (or the file cannot be read back). */
  loadIdentity(): WorkerIdentity | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.identityFile, 'utf8')) as Record<string, unknown>;
      const { hubUrl, workerId, name } = raw;
      let token = raw.token;
      if (typeof raw.tokenProtected === 'string') {
        if (!this.protection) return null;
        token = this.protection.decrypt(raw.tokenProtected.slice(PROTECTED_PREFIX.length));
      }
      if (![hubUrl, workerId, name, token].every((v) => typeof v === 'string' && v)) return null;
      return { hubUrl: hubUrl as string, workerId: workerId as string, name: name as string, token: token as string };
    } catch {
      return null;
    }
  }

  saveIdentity(identity: WorkerIdentity): void {
    const body: Record<string, string> = { hubUrl: identity.hubUrl, workerId: identity.workerId, name: identity.name };
    if (this.protection) body.tokenProtected = PROTECTED_PREFIX + this.protection.encrypt(identity.token);
    else body.token = identity.token;
    writeAtomic(this.identityFile, JSON.stringify(body, null, 2) + '\n');
  }

  /** Forgets the pairing, the cached schedule and everything still queued. */
  clear(): void {
    for (const file of [this.identityFile, this.scheduleFile, this.outboxFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  loadSchedule(): CachedSchedule | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.scheduleFile, 'utf8')) as CachedSchedule;
      if (typeof raw.version !== 'number' || !Array.isArray(raw.schedule?.mappings) || !Array.isArray(raw.schedule?.jobs)) {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  saveSchedule(cached: CachedSchedule): void {
    writeAtomic(this.scheduleFile, JSON.stringify(cached));
  }

  clearSchedule(): void {
    try {
      fs.rmSync(this.scheduleFile, { force: true });
    } catch {
      /* already gone */
    }
  }
}
