import { randomUUID } from 'crypto';
import { Database, transaction } from './sqlite';
import {
  CreateJobInput,
  CreateMappingInput,
  FileOutcome,
  FilterRule,
  HistoryListFilter,
  JobRecord,
  MappingConfig,
  mappingInUseMessage,
  MappingRecord,
  RunResult,
  RunStats,
  RunSummary,
  UpdateJobInput,
  UpdateMappingInput,
} from '../../shared/types';
import { normalizeFilterGroups } from '../../shared/filterGroups';
import { normalizeDailyTimes } from '../../shared/schedule';
import { lastInsertId, queryAll, queryOne, run, toBool, toInt } from './dbHelpers';
import { bumpScheduleVersion, getLocalWorkerId, ownerOf } from './workers';

function rowToFilterRule(row: Record<string, unknown>): FilterRule {
  return {
    field: String(row.field) as FilterRule['field'],
    operator: String(row.operator) as FilterRule['operator'],
    value: String(row.value),
    group: Number(row.group_index),
  };
}

function loadFilters(db: Database, mappingId: number): FilterRule[] {
  return queryAll(
    db,
    'SELECT field, operator, value, group_index FROM filter_rules WHERE mapping_id = ? ORDER BY sort_order',
    [mappingId]
  ).map(rowToFilterRule);
}

function rowToRecord(db: Database, row: Record<string, unknown>): MappingRecord {
  const id = Number(row.id);
  return {
    id,
    workerId: String(row.worker_id),
    name: String(row.name),
    sourcePath: String(row.source_path),
    destPath: String(row.dest_path),
    recursive: toBool(row.recursive),
    actionType: String(row.action_type) as MappingRecord['actionType'],
    conflictPolicy: String(row.conflict_policy) as MappingRecord['conflictPolicy'],
    enabled: toBool(row.enabled),
    scheduleType: String(row.schedule_type) as MappingRecord['scheduleType'],
    scheduleIntervalMinutes: toInt(row.schedule_interval_minutes),
    scheduleDailyTime: row.schedule_daily_time ? String(row.schedule_daily_time) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    filters: loadFilters(db, id),
    nextMappingId: toInt(row.next_mapping_id),
    keepNewest: toInt(row.keep_newest),
    keepNewestPerExtension: toBool(row.keep_newest_per_extension),
  };
}

function replaceFilterRules(db: Database, mappingId: number, filters: FilterRule[]): void {
  run(db, 'DELETE FROM filter_rules WHERE mapping_id = ?', [mappingId]);
  normalizeFilterGroups(filters).forEach((filter, index) => {
    run(
      db,
      'INSERT INTO filter_rules (mapping_id, field, operator, value, group_index, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [mappingId, filter.field, filter.operator, filter.value, filter.group, index]
    );
  });
}

export function toMappingConfig(record: MappingRecord): MappingConfig {
  return {
    id: record.id,
    name: record.name,
    sourcePath: record.sourcePath,
    destPath: record.destPath,
    recursive: record.recursive,
    conflictPolicy: record.conflictPolicy,
    filters: record.filters,
    actionType: record.actionType,
    keepNewest: record.keepNewest,
    keepNewestPerExtension: record.keepNewestPerExtension,
  };
}

/** Raises the schedule version of the worker that owns this mapping or job (no-op when it is gone). */
function bumpOwner(db: Database, table: 'mappings' | 'jobs', id: number): void {
  const workerId = ownerOf(db, table, id);
  if (workerId) bumpScheduleVersion(db, workerId);
}

function createMappingRows(db: Database, input: CreateMappingInput, workerId: string): number {
  run(
    db,
    `INSERT INTO mappings
      (name, source_path, dest_path, recursive, action_type, conflict_policy,
       keep_newest, keep_newest_per_extension, enabled, schedule_type, schedule_interval_minutes,
       schedule_daily_time, next_mapping_id, worker_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.sourcePath,
      input.destPath,
      input.recursive ? 1 : 0,
      input.actionType,
      input.conflictPolicy,
      input.keepNewest,
      input.keepNewestPerExtension ? 1 : 0,
      input.enabled ? 1 : 0,
      input.scheduleType,
      input.scheduleIntervalMinutes,
      input.scheduleDailyTime,
      input.nextMappingId,
      workerId,
    ]
  );
  const mappingId = lastInsertId(db);
  replaceFilterRules(db, mappingId, input.filters);
  return mappingId;
}

/** Creates a mapping on the given worker (this PC's `local` worker when none is named). */
/** A machine a mapping or job may be put on: it exists and has not been removed. */
function assertUsableWorker(db: Database, workerId: string): void {
  const row = queryOne(db, 'SELECT removed_at FROM workers WHERE id = ?', [workerId]);
  if (!row) throw new Error('That machine does not exist.');
  if (row.removed_at) throw new Error('That machine has been removed.');
}

/** A step that chains into another mapping must stay on the same machine. */
function assertChainOnSameWorker(db: Database, nextMappingId: number | null, workerId: string): void {
  if (nextMappingId == null) return;
  const owner = ownerOf(db, 'mappings', nextMappingId);
  if (owner != null && owner !== workerId) throw new Error('A mapping can only chain into a mapping on the same machine.');
}

export function createMapping(db: Database, input: CreateMappingInput, workerId?: string): number {
  return transaction(db, () => {
    const owner = workerId ?? input.workerId ?? getLocalWorkerId(db);
    assertUsableWorker(db, owner);
    assertChainOnSameWorker(db, input.nextMappingId, owner);
    const id = createMappingRows(db, input, owner);
    bumpScheduleVersion(db, owner);
    return id;
  });
}

function updateMappingRows(db: Database, mappingId: number, input: UpdateMappingInput): void {
  run(
    db,
    `UPDATE mappings SET
      name = ?, source_path = ?, dest_path = ?, recursive = ?, action_type = ?,
      conflict_policy = ?, keep_newest = ?, keep_newest_per_extension = ?, enabled = ?, schedule_type = ?,
      schedule_interval_minutes = ?, schedule_daily_time = ?, next_mapping_id = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
    [
      input.name,
      input.sourcePath,
      input.destPath,
      input.recursive ? 1 : 0,
      input.actionType,
      input.conflictPolicy,
      input.keepNewest,
      input.keepNewestPerExtension ? 1 : 0,
      input.enabled ? 1 : 0,
      input.scheduleType,
      input.scheduleIntervalMinutes,
      input.scheduleDailyTime,
      input.nextMappingId,
      mappingId,
    ]
  );
  replaceFilterRules(db, mappingId, input.filters);
}

export function updateMapping(db: Database, mappingId: number, input: UpdateMappingInput): void {
  transaction(db, () => {
    const owner = ownerOf(db, 'mappings', mappingId);
    if (owner && input.workerId && input.workerId !== owner) {
      throw new Error('A mapping cannot be moved to another machine.');
    }
    if (owner) assertChainOnSameWorker(db, input.nextMappingId, owner);
    updateMappingRows(db, mappingId, input);
    bumpOwner(db, 'mappings', mappingId);
  });
}

export function cloneMapping(db: Database, mappingId: number, newName: string): number {
  const source = getMapping(db, mappingId);
  if (!source) {
    throw new Error(`Mapping #${mappingId} not found`);
  }
  return createMapping(
    db,
    {
    name: newName,
    sourcePath: source.sourcePath,
    destPath: source.destPath,
    recursive: source.recursive,
    conflictPolicy: source.conflictPolicy,
    enabled: source.enabled,
    scheduleType: source.scheduleType,
    scheduleIntervalMinutes: source.scheduleIntervalMinutes,
    scheduleDailyTime: source.scheduleDailyTime,
    filters: source.filters,
    nextMappingId: source.nextMappingId,
    actionType: source.actionType,
    keepNewest: source.keepNewest,
    keepNewestPerExtension: source.keepNewestPerExtension,
    },
    source.workerId
  );
}

export function listJobsUsingMapping(db: Database, mappingId: number): { id: number; name: string }[] {
  return queryAll(
    db,
    `SELECT DISTINCT j.id, j.name
     FROM jobs j
     JOIN job_steps s ON s.job_id = j.id
     WHERE s.mapping_id = ?
     ORDER BY j.name COLLATE NOCASE`,
    [mappingId]
  ).map((row) => ({ id: Number(row.id), name: String(row.name) }));
}

export function deleteMapping(db: Database, mappingId: number): void {
  const jobs = listJobsUsingMapping(db, mappingId);
  if (jobs.length) {
    const mapping = getMapping(db, mappingId);
    const name = mapping?.name ?? `Mapping #${mappingId}`;
    throw new Error(mappingInUseMessage(name, jobs.map((job) => job.name)));
  }
  transaction(db, () => {
    bumpOwner(db, 'mappings', mappingId);
    run(db, 'DELETE FROM mappings WHERE id = ?', [mappingId]);
  });
}

export function setMappingEnabled(db: Database, mappingId: number, enabled: boolean): void {
  transaction(db, () => {
    run(
      db,
      "UPDATE mappings SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      [enabled ? 1 : 0, mappingId]
    );
    bumpOwner(db, 'mappings', mappingId);
  });
}

export function getMapping(db: Database, mappingId: number): MappingRecord | null {
  const row = queryOne(db, 'SELECT * FROM mappings WHERE id = ?', [mappingId]);
  return row ? rowToRecord(db, row) : null;
}

export function listMappings(db: Database, enabledOnly = false, workerId?: string): MappingRecord[] {
  const where = [enabledOnly ? 'enabled = 1' : null, workerId ? 'worker_id = ?' : null].filter(Boolean);
  const sql = `SELECT * FROM mappings${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE`;
  return queryAll(db, sql, workerId ? [workerId] : []).map((row) => rowToRecord(db, row));
}

function rowToRunSummary(row: Record<string, unknown>): RunSummary {
  return {
    id: Number(row.id),
    workerId: String(row.worker_id),
    runUid: String(row.run_uid),
    mappingId: toInt(row.mapping_id),
    mappingNameSnapshot: String(row.mapping_name_snapshot),
    jobId: toInt(row.job_id),
    jobNameSnapshot: row.job_name_snapshot ? String(row.job_name_snapshot) : null,
    triggerType: String(row.trigger_type) as RunSummary['triggerType'],
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    filesMoved: Number(row.files_moved),
    filesCopied: Number(row.files_copied),
    filesDeleted: Number(row.files_deleted),
    filesSkipped: Number(row.files_skipped),
    filesErrored: Number(row.files_errored),
    filesExtracted: Number(row.files_extracted),
    filesZipped: Number(row.files_zipped),
    status: String(row.status) as RunSummary['status'],
    errorMessage: row.error_message ? String(row.error_message) : null,
    undoneByRunId: toInt(row.undone_by_run_id),
    triggeredByRunId: toInt(row.triggered_by_run_id),
  };
}

function countOutcomes(result: RunResult, outcome: FileOutcome['outcome']): number {
  return result.fileOutcomes.filter((f) => f.outcome === outcome).length;
}

export function buildRunResult(startedAt: Date, finishedAt: Date, fileOutcomes: FileOutcome[]): RunResult {
  const result: RunResult = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    fileOutcomes,
    filesMoved: 0,
    filesCopied: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    filesErrored: 0,
    filesExtracted: 0,
    filesZipped: 0,
  };
  result.filesMoved = countOutcomes(result, 'moved');
  result.filesCopied = countOutcomes(result, 'copied');
  result.filesDeleted = countOutcomes(result, 'deleted');
  result.filesSkipped = countOutcomes(result, 'skipped');
  result.filesErrored = countOutcomes(result, 'error');
  result.filesExtracted = countOutcomes(result, 'extracted');
  result.filesZipped = countOutcomes(result, 'zipped');
  return result;
}

export interface RecordRunParams {
  mappingId: number | null;
  mappingNameSnapshot: string;
  triggerType: RunSummary['triggerType'];
  result: RunResult;
  status: RunSummary['status'];
  errorMessage?: string | null;
  triggeredByRunId?: number | null;
  jobId?: number | null;
  jobNameSnapshot?: string | null;
  /** Who ran it. Defaults to this PC's `local` worker. */
  workerId?: string;
  /**
   * Made by whoever runs the job (the worker), so a report that arrives twice is stored once.
   * Generated here for runs the hub itself makes (log purges).
   */
  runUid?: string;
}

/** The history id of the run with this uid, or null. */
export function getRunIdByUid(db: Database, runUid: string): number | null {
  const row = queryOne(db, 'SELECT id FROM run_history WHERE run_uid = ?', [runUid]);
  return row ? Number(row.id) : null;
}

function recordRunRows(db: Database, params: RecordRunParams): { runId: number; duplicate: boolean } {
  const runUid = params.runUid ?? randomUUID();
  // A report that is delivered twice (a resend after a lost acknowledgement) is stored once:
  // the second copy is ignored, and its file rows are not inserted again.
  const existing = getRunIdByUid(db, runUid);
  if (existing != null) return { runId: existing, duplicate: true };
  run(
    db,
    `INSERT INTO run_history
      (mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
       files_moved, files_copied, files_deleted, files_skipped, files_errored, files_extracted, files_zipped,
       status, error_message, triggered_by_run_id, job_id, job_name_snapshot, worker_id, run_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.mappingId,
      params.mappingNameSnapshot,
      params.triggerType,
      params.result.startedAt,
      params.result.finishedAt,
      params.result.filesMoved,
      params.result.filesCopied,
      params.result.filesDeleted,
      params.result.filesSkipped,
      params.result.filesErrored,
      params.result.filesExtracted,
      params.result.filesZipped,
      params.status,
      params.errorMessage ?? null,
      params.triggeredByRunId ?? null,
      params.jobId ?? null,
      params.jobNameSnapshot ?? null,
      params.workerId ?? getLocalWorkerId(db),
      runUid,
    ]
  );
  const runId = lastInsertId(db);
  params.result.fileOutcomes.forEach((file) => {
    run(
      db,
      `INSERT INTO run_history_files (run_id, source_path, dest_path, outcome, reason, file_size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, file.sourcePath, file.destPath, file.outcome, file.reason, file.sizeBytes]
    );
  });
  return { runId, duplicate: false };
}

export function recordRun(db: Database, params: RecordRunParams): number {
  return transaction(db, () => recordRunRows(db, params).runId);
}

/** Like recordRun, but says whether the report was a repeat of one already stored. */
export function recordRunOnce(db: Database, params: RecordRunParams): { runId: number; duplicate: boolean } {
  return transaction(db, () => recordRunRows(db, params));
}

export function listRuns(db: Database, filter?: HistoryListFilter | number | null): RunSummary[] {
  const mappingId = typeof filter === 'number' || filter == null ? filter : filter.mappingId;
  const jobId = typeof filter === 'object' && filter != null ? filter.jobId : null;
  if (jobId != null) {
    return queryAll(db, 'SELECT * FROM run_history WHERE job_id = ? ORDER BY started_at DESC', [jobId]).map(
      rowToRunSummary
    );
  }
  if (mappingId != null) {
    return queryAll(db, 'SELECT * FROM run_history WHERE mapping_id = ? ORDER BY started_at DESC', [mappingId]).map(
      rowToRunSummary
    );
  }
  return queryAll(db, 'SELECT * FROM run_history ORDER BY started_at DESC').map(rowToRunSummary);
}

export function getRun(db: Database, runId: number): RunSummary | null {
  const row = queryOne(db, 'SELECT * FROM run_history WHERE id = ?', [runId]);
  return row ? rowToRunSummary(row) : null;
}

export function markRunUndone(db: Database, runId: number, undoneByRunId: number): void {
  run(db, 'UPDATE run_history SET undone_by_run_id = ? WHERE id = ?', [undoneByRunId, runId]);
}

export function getRunStats(db: Database, mappingId: number): RunStats {
  const countRow = queryOne(db, 'SELECT COUNT(*) AS c FROM run_history WHERE mapping_id = ?', [mappingId]);
  const lastRow = queryOne(
    db,
    'SELECT * FROM run_history WHERE mapping_id = ? ORDER BY started_at DESC LIMIT 1',
    [mappingId]
  );
  return {
    runCount: Number(countRow?.c ?? 0),
    lastRun: lastRow ? rowToRunSummary(lastRow) : null,
  };
}

export function getRunDetail(db: Database, runId: number): FileOutcome[] {
  return queryAll(
    db,
    'SELECT source_path, dest_path, outcome, reason, file_size_bytes FROM run_history_files WHERE run_id = ?',
    [runId]
  ).map((row) => ({
    sourcePath: String(row.source_path),
    destPath: row.dest_path ? String(row.dest_path) : null,
    outcome: String(row.outcome) as FileOutcome['outcome'],
    reason: row.reason ? String(row.reason) : null,
    sizeBytes: toInt(row.file_size_bytes),
  }));
}

export function countRuns(db: Database): number {
  const row = queryOne(db, 'SELECT COUNT(*) AS c FROM run_history');
  return Number(row?.c ?? 0);
}

export function deleteRunsOlderThan(db: Database, cutoffIso: string): number {
  const row = queryOne(db, 'SELECT COUNT(*) AS c FROM run_history WHERE started_at < ?', [cutoffIso]);
  const count = Number(row?.c ?? 0);
  if (count === 0) return 0;
  run(db, 'DELETE FROM run_history WHERE started_at < ?', [cutoffIso]);
  return count;
}

export function deleteAllRuns(db: Database): number {
  const count = countRuns(db);
  if (count === 0) return 0;
  run(db, 'DELETE FROM run_history');
  return count;
}

export function getSetting(db: Database, key: string, defaultValue: string | null = null): string | null {
  const row = queryOne(db, 'SELECT value FROM app_settings WHERE key = ?', [key]);
  return row?.value != null ? String(row.value) : defaultValue;
}

export function setSetting(db: Database, key: string, value: string): void {
  run(
    db,
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

function loadJobSteps(db: Database, jobId: number): MappingRecord[] {
  const rows = queryAll(
    db,
    `SELECT m.* FROM job_steps s
     JOIN mappings m ON m.id = s.mapping_id
     WHERE s.job_id = ?
     ORDER BY s.sort_order, s.id`,
    [jobId]
  );
  return rows.map((row) => rowToRecord(db, row));
}

/** Job run times are stored as comma-separated HH:MM text. */
function parseDailyTimes(value: unknown): string[] {
  return value ? normalizeDailyTimes(String(value).split(',')) : [];
}

function rowToJob(db: Database, row: Record<string, unknown>): JobRecord {
  const id = Number(row.id);
  return {
    id,
    workerId: String(row.worker_id),
    name: String(row.name),
    enabled: toBool(row.enabled),
    scheduleType: String(row.schedule_type) as JobRecord['scheduleType'],
    scheduleIntervalMinutes: toInt(row.schedule_interval_minutes),
    scheduleDailyTimes: parseDailyTimes(row.schedule_daily_times),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    catchUp: toBool(row.catch_up),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    steps: loadJobSteps(db, id),
  };
}

function replaceJobSteps(db: Database, jobId: number, mappingIds: number[], workerId: string): void {
  // A job runs on one machine, so every step must be a mapping of that same worker.
  for (const mappingId of mappingIds) {
    const owner = ownerOf(db, 'mappings', mappingId);
    if (owner != null && owner !== workerId) {
      throw new Error('A job can only use mappings from one machine, and these belong to different machines.');
    }
  }
  run(db, 'DELETE FROM job_steps WHERE job_id = ?', [jobId]);
  mappingIds.forEach((mappingId, index) => {
    run(db, 'INSERT INTO job_steps (job_id, mapping_id, sort_order) VALUES (?, ?, ?)', [jobId, mappingId, index]);
  });
}

/** Values for schedule_daily_time (the first time, kept so older builds still read a job) and schedule_daily_times. */
function dailyTimeColumns(times: string[]): [string | null, string | null] {
  const normalized = normalizeDailyTimes(times);
  return normalized.length ? [normalized[0], normalized.join(',')] : [null, null];
}

function createJobRows(db: Database, input: CreateJobInput, workerId: string): number {
  run(
    db,
    `INSERT INTO jobs
      (name, enabled, catch_up, schedule_type, schedule_interval_minutes, schedule_daily_time, schedule_daily_times,
       worker_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.enabled ? 1 : 0,
      input.catchUp ? 1 : 0,
      input.scheduleType,
      input.scheduleIntervalMinutes,
      ...dailyTimeColumns(input.scheduleDailyTimes),
      workerId,
    ]
  );
  const jobId = lastInsertId(db);
  replaceJobSteps(db, jobId, input.mappingIds, workerId);
  return jobId;
}

/** Creates a job on the given worker (this PC's `local` worker when none is named). */
export function createJob(db: Database, input: CreateJobInput, workerId?: string): number {
  return transaction(db, () => {
    // A job runs on the machine its steps belong to; with no steps it is the local worker's.
    const firstOwner = input.mappingIds.length ? ownerOf(db, 'mappings', input.mappingIds[0]) : null;
    const owner = workerId ?? firstOwner ?? getLocalWorkerId(db);
    assertUsableWorker(db, owner);
    const id = createJobRows(db, input, owner);
    bumpScheduleVersion(db, owner);
    return id;
  });
}

function updateJobRows(db: Database, jobId: number, input: UpdateJobInput): void {
  run(
    db,
    `UPDATE jobs SET
      name = ?, enabled = ?, catch_up = ?, schedule_type = ?, schedule_interval_minutes = ?,
      schedule_daily_time = ?, schedule_daily_times = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
    [
      input.name,
      input.enabled ? 1 : 0,
      input.catchUp ? 1 : 0,
      input.scheduleType,
      input.scheduleIntervalMinutes,
      ...dailyTimeColumns(input.scheduleDailyTimes),
      jobId,
    ]
  );
  const owner = ownerOf(db, 'jobs', jobId);
  if (owner) replaceJobSteps(db, jobId, input.mappingIds, owner);
}

export function updateJob(db: Database, jobId: number, input: UpdateJobInput): void {
  transaction(db, () => {
    updateJobRows(db, jobId, input);
    bumpOwner(db, 'jobs', jobId);
  });
}

/**
 * Records when a job last ran in full. Deliberately does NOT raise the worker's schedule version:
 * it is run state the worker produced itself, and resending the schedule would reset its timers.
 */
export function setJobLastRun(db: Database, jobId: number, whenIso: string): void {
  run(db, 'UPDATE jobs SET last_run_at = ? WHERE id = ?', [whenIso, jobId]);
}

export function deleteJob(db: Database, jobId: number): void {
  transaction(db, () => {
    bumpOwner(db, 'jobs', jobId);
    run(db, 'DELETE FROM jobs WHERE id = ?', [jobId]);
  });
}

export function setJobEnabled(db: Database, jobId: number, enabled: boolean): void {
  transaction(db, () => {
    run(
      db,
      "UPDATE jobs SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      [enabled ? 1 : 0, jobId]
    );
    bumpOwner(db, 'jobs', jobId);
  });
}

export function getJob(db: Database, jobId: number): JobRecord | null {
  const row = queryOne(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  return row ? rowToJob(db, row) : null;
}

export function listJobs(db: Database, enabledOnly = false, workerId?: string): JobRecord[] {
  const where = [enabledOnly ? 'enabled = 1' : null, workerId ? 'worker_id = ?' : null].filter(Boolean);
  const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE`;
  return queryAll(db, sql, workerId ? [workerId] : []).map((row) => rowToJob(db, row));
}

export function getJobStats(db: Database, jobId: number): RunStats {
  const roots = queryAll(
    db,
    `SELECT * FROM run_history
     WHERE job_id = ? AND triggered_by_run_id IS NULL AND trigger_type != ?
     ORDER BY started_at DESC`,
    [jobId, 'undo']
  );
  if (!roots.length) return { runCount: 0, lastRun: null };

  const all = queryAll(db, 'SELECT * FROM run_history WHERE job_id = ? ORDER BY id', [jobId]).map(rowToRunSummary);
  const lastRoot = rowToRunSummary(roots[0]);
  const chain: RunSummary[] = [];
  let currentId: number | null = lastRoot.id;
  while (currentId != null) {
    const node = all.find((r) => r.id === currentId);
    if (!node) break;
    chain.push(node);
    const next = all.find((r) => r.triggeredByRunId === currentId);
    currentId = next?.id ?? null;
  }

  return {
    runCount: roots.length,
    lastRun: {
      ...lastRoot,
      filesMoved: chain.reduce((sum, r) => sum + r.filesMoved, 0),
      filesCopied: chain.reduce((sum, r) => sum + r.filesCopied, 0),
      filesDeleted: chain.reduce((sum, r) => sum + r.filesDeleted, 0),
      filesSkipped: chain.reduce((sum, r) => sum + r.filesSkipped, 0),
      filesErrored: chain.reduce((sum, r) => sum + r.filesErrored, 0),
      filesExtracted: chain.reduce((sum, r) => sum + r.filesExtracted, 0),
      filesZipped: chain.reduce((sum, r) => sum + r.filesZipped, 0),
    },
  };
}

/** Turn existing mapping chains into jobs once, so scheduled work keeps firing. */
function migrateChainsToJobsRows(db: Database): void {
  if (getSetting(db, 'jobs_migrated') === '1') return;

  const mappings = listMappings(db);
  const referenced = new Set(
    mappings.map((m) => m.nextMappingId).filter((id): id is number => id != null)
  );

  for (const mapping of mappings) {
    const isHead = !referenced.has(mapping.id);
    const hasOwnSchedule = mapping.scheduleType !== 'manual';
    if (!isHead && !hasOwnSchedule) continue;

    const mappingIds: number[] = [];
    const visited = new Set<number>();
    let current: MappingRecord | null = mapping;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      mappingIds.push(current.id);
      current = current.nextMappingId != null ? getMapping(db, current.nextMappingId) : null;
    }

    createJob(db, {
      name: mapping.name,
      enabled: mapping.enabled,
      scheduleType: mapping.scheduleType,
      scheduleIntervalMinutes: mapping.scheduleIntervalMinutes,
      scheduleDailyTimes: mapping.scheduleDailyTime ? [mapping.scheduleDailyTime] : [],
      mappingIds,
    }, mapping.workerId);
  }

  setSetting(db, 'jobs_migrated', '1');
}

export function migrateChainsToJobs(db: Database): void {
  transaction(db, () => migrateChainsToJobsRows(db));
}
