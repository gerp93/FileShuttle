import { randomUUID } from 'crypto';
import * as os from 'os';
import { Database, transaction } from './sqlite';
import { queryAll, queryOne, run, toInt } from './dbHelpers';

/**
 * A worker is a machine that actually moves files. The `local` worker runs inside the same
 * process as the hub; a `remote` one is another computer that was paired with the hub (see
 * workerAccess.ts) and connects to it over the network. Every mapping, job and run belongs to one worker.
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
  /** A remote worker that holds a token (false once the token is revoked, and always for the local one). */
  hasToken: boolean;
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
    hasToken: row.token_hash != null && String(row.token_hash) !== '',
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

export function listWorkers(db: Database): WorkerRecord[] {
  return queryAll(db, 'SELECT * FROM workers ORDER BY created_at, id').map(rowToWorker);
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
  info: { appVersion: string; protocolVersion: number },
  whenIso: string
): void {
  run(db, 'UPDATE workers SET app_version = ?, protocol_version = ?, last_seen_at = ? WHERE id = ?', [
    info.appVersion,
    info.protocolVersion,
    whenIso,
    workerId,
  ]);
}

export function touchWorker(db: Database, workerId: string, whenIso: string): void {
  run(db, 'UPDATE workers SET last_seen_at = ? WHERE id = ?', [whenIso, workerId]);
}

/** Which worker a mapping or job belongs to; null when it does not exist. */
export function ownerOf(db: Database, table: 'mappings' | 'jobs', id: number): string | null {
  const row = queryOne(db, `SELECT worker_id FROM ${table} WHERE id = ?`, [id]);
  return row?.worker_id ? String(row.worker_id) : null;
}

/** Whether a worker should be shown as online: it is connected and the hub has heard from it recently. */
export function isWorkerOnline(
  worker: Pick<WorkerRecord, 'lastSeenAt'>,
  connected: boolean,
  nowMs: number,
  offlineAfterMs: number
): boolean {
  if (!connected || !worker.lastSeenAt) return false;
  const seen = Date.parse(worker.lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen <= offlineAfterMs;
}
