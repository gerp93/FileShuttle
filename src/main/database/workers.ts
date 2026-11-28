import { randomUUID } from 'crypto';
import * as os from 'os';
import { Database, transaction } from './sqlite';
import { queryAll, queryOne, run, toInt } from './dbHelpers';

/**
 * A worker is a machine that actually moves files. The `local` worker runs inside the same
 * process as the hub; a `remote` worker is another computer, paired with a token (only its hash
 * is kept here). Every mapping, job and run belongs to one worker.
 */
export type WorkerKind = 'local' | 'remote';

export interface WorkerRecord {
  id: string;
  name: string;
  kind: WorkerKind;
  appVersion: string | null;
  protocolVersion: number | null;
  /** Goes up by one whenever anything that belongs to this worker's schedule changes. */
  scheduleVersion: number;
  /** The newest schedule version the worker said it has applied. */
  scheduleAckedVersion: number;
  lastSeenAt: string | null;
  createdAt: string;
  /** `process.platform` of a remote worker's machine, as it reported. */
  platform: string | null;
  pairedAt: string | null;
  /** Set when the machine was removed: its token no longer works. The row stays because run history points at it. */
  removedAt: string | null;
}

function rowToWorker(row: Record<string, unknown>): WorkerRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as WorkerKind,
    appVersion: row.app_version ? String(row.app_version) : null,
    protocolVersion: toInt(row.protocol_version),
    scheduleVersion: Number(row.schedule_version),
    scheduleAckedVersion: Number(row.schedule_acked_version),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    createdAt: String(row.created_at),
    platform: row.platform ? String(row.platform) : null,
    pairedAt: row.paired_at ? String(row.paired_at) : null,
    removedAt: row.removed_at ? String(row.removed_at) : null,
  };
}

function computerName(): string {
  try {
    return os.hostname().trim() || 'This PC';
  } catch {
    return 'This PC';
  }
}

/** The `local` worker's id, creating the row when none exists yet (only a hand-edited database lacks it). */
export function ensureLocalWorker(db: Database): string {
  return transaction(db, () => {
    const existing = queryOne(db, "SELECT id FROM workers WHERE kind = 'local' ORDER BY created_at, id LIMIT 1");
    if (existing) return String(existing.id);
    const id = randomUUID();
    run(db, "INSERT INTO workers (id, name, kind, created_at) VALUES (?, ?, 'local', ?)", [
      id,
      computerName(),
      new Date().toISOString(),
    ]);
    return id;
  });
}

export function getLocalWorkerId(db: Database): string {
  const row = queryOne(db, "SELECT id FROM workers WHERE kind = 'local' ORDER BY created_at, id LIMIT 1");
  return row ? String(row.id) : ensureLocalWorker(db);
}

export function getWorker(db: Database, workerId: string): WorkerRecord | null {
  const row = queryOne(db, 'SELECT * FROM workers WHERE id = ?', [workerId]);
  return row ? rowToWorker(row) : null;
}

/** The workers that can be used. A removed machine is left out unless asked for (its history still names it). */
export function listWorkers(db: Database, includeRemoved = false): WorkerRecord[] {
  const where = includeRemoved ? '' : 'WHERE removed_at IS NULL';
  return queryAll(db, `SELECT * FROM workers ${where} ORDER BY created_at, id`).map(rowToWorker);
}

const NAME_MAX = 60;

/** A machine name from outside: control characters out, trimmed, never empty. */
export function cleanWorkerName(raw: unknown, fallback = 'Remote machine'): string {
  // eslint-disable-next-line no-control-regex
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (text || fallback).slice(0, NAME_MAX);
}

/** The name, with " (2)", " (3)" ... added when another machine in use already has it. */
function uniqueWorkerName(db: Database, name: string): string {
  const taken = new Set(listWorkers(db).map((w) => w.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, NAME_MAX - 5)} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Adds a paired machine. Only the hash of its token is stored. */
export function createRemoteWorker(
  db: Database,
  info: { name: string; tokenHash: string; platform?: string | null },
  whenIso: string
): WorkerRecord {
  const id = randomUUID();
  const name = uniqueWorkerName(db, cleanWorkerName(info.name));
  run(
    db,
    "INSERT INTO workers (id, name, kind, token_hash, platform, paired_at, created_at) VALUES (?, ?, 'remote', ?, ?, ?, ?)",
    [id, name, info.tokenHash, info.platform ?? null, whenIso, whenIso]
  );
  return getWorker(db, id)!;
}

/** The stored token hash of a machine that is still paired, else null. */
export function getWorkerTokenHash(db: Database, workerId: string): string | null {
  const row = queryOne(
    db,
    "SELECT token_hash FROM workers WHERE id = ? AND kind = 'remote' AND removed_at IS NULL AND token_hash IS NOT NULL",
    [workerId]
  );
  return row?.token_hash ? String(row.token_hash) : null;
}

/** Cuts a machine off: its token hash is deleted, so nothing can connect as it again. The row stays for history. */
export function revokeWorker(db: Database, workerId: string, whenIso: string): void {
  run(db, "UPDATE workers SET token_hash = NULL, removed_at = ? WHERE id = ? AND kind = 'remote'", [whenIso, workerId]);
  run(db, 'DELETE FROM pending_runs WHERE worker_id = ?', [workerId]);
}

/** How many mappings and jobs a worker owns. */
export function workerLoad(db: Database, workerId: string): { mappings: number; jobs: number } {
  const count = (table: string): number =>
    Number(queryOne(db, `SELECT COUNT(*) AS n FROM ${table} WHERE worker_id = ?`, [workerId])?.n ?? 0);
  return { mappings: count('mappings'), jobs: count('jobs') };
}

/**
 * Raises the worker's schedule version. Call it inside the same transaction as the change to a
 * mapping, job, step, filter or schedule that belongs to that worker.
 */
export function bumpScheduleVersion(db: Database, workerId: string): void {
  run(db, 'UPDATE workers SET schedule_version = schedule_version + 1 WHERE id = ?', [workerId]);
}

export function getScheduleVersion(db: Database, workerId: string): number {
  const row = queryOne(db, 'SELECT schedule_version FROM workers WHERE id = ?', [workerId]);
  return Number(row?.schedule_version ?? 0);
}

export function setScheduleAcked(db: Database, workerId: string, version: number): void {
  run(db, 'UPDATE workers SET schedule_acked_version = ? WHERE id = ?', [version, workerId]);
}

/** Records what a worker said about itself when it connected. */
export function recordWorkerHello(
  db: Database,
  workerId: string,
  info: { appVersion: string; protocolVersion: number; platform?: string | null },
  whenIso: string
): void {
  run(
    db,
    'UPDATE workers SET app_version = ?, protocol_version = ?, last_seen_at = ?, platform = COALESCE(?, platform) WHERE id = ?',
    [info.appVersion, info.protocolVersion, whenIso, info.platform ?? null, workerId]
  );
}

export function touchWorker(db: Database, workerId: string, whenIso: string): void {
  run(db, 'UPDATE workers SET last_seen_at = ? WHERE id = ?', [whenIso, workerId]);
}

/** Which worker a mapping or job belongs to; null when it does not exist. */
export function ownerOf(db: Database, table: 'mappings' | 'jobs', id: number): string | null {
  const row = queryOne(db, `SELECT worker_id FROM ${table} WHERE id = ?`, [id]);
  return row?.worker_id ? String(row.worker_id) : null;
}

// "Run now" requests waiting for a machine that is offline -------------------------------------

export interface QueuedRun {
  jobId: number;
  workerId: string;
  trigger: 'manual' | 'scheduled';
  queuedAt: string;
}

/** Remembers a run for a machine that is offline. A job already waiting is not added twice; returns false then. */
export function queueRun(db: Database, entry: { jobId: number; workerId: string; trigger: 'manual' | 'scheduled' }, whenIso: string): boolean {
  const before = queryOne(db, 'SELECT 1 AS x FROM pending_runs WHERE job_id = ?', [entry.jobId]);
  if (before) return false;
  run(db, 'INSERT INTO pending_runs (job_id, worker_id, trigger, queued_at) VALUES (?, ?, ?, ?)', [
    entry.jobId,
    entry.workerId,
    entry.trigger,
    whenIso,
  ]);
  return true;
}

function rowToQueued(row: Record<string, unknown>): QueuedRun {
  return {
    jobId: Number(row.job_id),
    workerId: String(row.worker_id),
    trigger: row.trigger === 'scheduled' ? 'scheduled' : 'manual',
    queuedAt: String(row.queued_at),
  };
}

export function listQueuedRuns(db: Database, workerId?: string): QueuedRun[] {
  const rows = workerId
    ? queryAll(db, 'SELECT * FROM pending_runs WHERE worker_id = ? ORDER BY queued_at, job_id', [workerId])
    : queryAll(db, 'SELECT * FROM pending_runs ORDER BY queued_at, job_id');
  return rows.map(rowToQueued);
}

export function getQueuedRun(db: Database, jobId: number): QueuedRun | null {
  const row = queryOne(db, 'SELECT * FROM pending_runs WHERE job_id = ?', [jobId]);
  return row ? rowToQueued(row) : null;
}

/** Forgets a queued run. Returns whether there was one. */
export function removeQueuedRun(db: Database, jobId: number): boolean {
  const existed = !!queryOne(db, 'SELECT 1 AS x FROM pending_runs WHERE job_id = ?', [jobId]);
  if (existed) run(db, 'DELETE FROM pending_runs WHERE job_id = ?', [jobId]);
  return existed;
}
