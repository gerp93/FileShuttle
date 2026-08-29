import { Database } from 'sql.js';
import {
  CreateMappingInput,
  FileOutcome,
  FilterRule,
  MappingConfig,
  MappingRecord,
  RunResult,
  RunStats,
  RunSummary,
  UpdateMappingInput,
} from '../../shared/types';
import { lastInsertId, queryAll, queryOne, run, toBool, toInt } from './dbHelpers';

function rowToFilterRule(row: Record<string, unknown>): FilterRule {
  return {
    field: String(row.field) as FilterRule['field'],
    operator: String(row.operator) as FilterRule['operator'],
    value: String(row.value),
  };
}

function loadFilters(db: Database, mappingId: number): FilterRule[] {
  return queryAll(
    db,
    'SELECT field, operator, value FROM filter_rules WHERE mapping_id = ? ORDER BY sort_order',
    [mappingId]
  ).map(rowToFilterRule);
}

function rowToRecord(db: Database, row: Record<string, unknown>): MappingRecord {
  const id = Number(row.id);
  return {
    id,
    name: String(row.name),
    sourcePath: String(row.source_path),
    destPath: String(row.dest_path),
    recursive: toBool(row.recursive),
    actionType: String(row.action_type) as MappingRecord['actionType'],
    conflictPolicy: String(row.conflict_policy) as MappingRecord['conflictPolicy'],
    filterMatchMode: String(row.filter_match_mode) as MappingRecord['filterMatchMode'],
    enabled: toBool(row.enabled),
    scheduleType: String(row.schedule_type) as MappingRecord['scheduleType'],
    scheduleIntervalMinutes: toInt(row.schedule_interval_minutes),
    scheduleDailyTime: row.schedule_daily_time ? String(row.schedule_daily_time) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    filters: loadFilters(db, id),
    nextMappingId: toInt(row.next_mapping_id),
  };
}

function replaceFilterRules(db: Database, mappingId: number, filters: FilterRule[]): void {
  run(db, 'DELETE FROM filter_rules WHERE mapping_id = ?', [mappingId]);
  filters.forEach((filter, index) => {
    run(db, 'INSERT INTO filter_rules (mapping_id, field, operator, value, sort_order) VALUES (?, ?, ?, ?, ?)', [
      mappingId,
      filter.field,
      filter.operator,
      filter.value,
      index,
    ]);
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
    filterMatchMode: record.filterMatchMode,
    filters: record.filters,
    actionType: record.actionType,
  };
}

export function createMapping(db: Database, input: CreateMappingInput): number {
  run(
    db,
    `INSERT INTO mappings
      (name, source_path, dest_path, recursive, action_type, conflict_policy, filter_match_mode,
       enabled, schedule_type, schedule_interval_minutes, schedule_daily_time, next_mapping_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.sourcePath,
      input.destPath,
      input.recursive ? 1 : 0,
      input.actionType,
      input.conflictPolicy,
      input.filterMatchMode,
      input.enabled ? 1 : 0,
      input.scheduleType,
      input.scheduleIntervalMinutes,
      input.scheduleDailyTime,
      input.nextMappingId,
    ]
  );
  const mappingId = lastInsertId(db);
  replaceFilterRules(db, mappingId, input.filters);
  return mappingId;
}

export function updateMapping(db: Database, mappingId: number, input: UpdateMappingInput): void {
  run(
    db,
    `UPDATE mappings SET
      name = ?, source_path = ?, dest_path = ?, recursive = ?, action_type = ?,
      conflict_policy = ?, filter_match_mode = ?, enabled = ?, schedule_type = ?,
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
      input.filterMatchMode,
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

export function deleteMapping(db: Database, mappingId: number): void {
  run(db, 'DELETE FROM mappings WHERE id = ?', [mappingId]);
}

export function setMappingEnabled(db: Database, mappingId: number, enabled: boolean): void {
  run(
    db,
    "UPDATE mappings SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [enabled ? 1 : 0, mappingId]
  );
}

export function getMapping(db: Database, mappingId: number): MappingRecord | null {
  const row = queryOne(db, 'SELECT * FROM mappings WHERE id = ?', [mappingId]);
  return row ? rowToRecord(db, row) : null;
}

export function listMappings(db: Database, enabledOnly = false): MappingRecord[] {
  const sql = enabledOnly
    ? 'SELECT * FROM mappings WHERE enabled = 1 ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM mappings ORDER BY name COLLATE NOCASE';
  return queryAll(db, sql).map((row) => rowToRecord(db, row));
}

function rowToRunSummary(row: Record<string, unknown>): RunSummary {
  return {
    id: Number(row.id),
    mappingId: Number(row.mapping_id),
    mappingNameSnapshot: String(row.mapping_name_snapshot),
    triggerType: String(row.trigger_type) as RunSummary['triggerType'],
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    filesMoved: Number(row.files_moved),
    filesCopied: Number(row.files_copied),
    filesDeleted: Number(row.files_deleted),
    filesSkipped: Number(row.files_skipped),
    filesErrored: Number(row.files_errored),
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
  };
  result.filesMoved = countOutcomes(result, 'moved');
  result.filesCopied = countOutcomes(result, 'copied');
  result.filesDeleted = countOutcomes(result, 'deleted');
  result.filesSkipped = countOutcomes(result, 'skipped');
  result.filesErrored = countOutcomes(result, 'error');
  return result;
}

export function recordRun(
  db: Database,
  params: {
    mappingId: number;
    mappingNameSnapshot: string;
    triggerType: RunSummary['triggerType'];
    result: RunResult;
    status: RunSummary['status'];
    errorMessage?: string | null;
    triggeredByRunId?: number | null;
  }
): number {
  run(
    db,
    `INSERT INTO run_history
      (mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
       files_moved, files_copied, files_deleted, files_skipped, files_errored, status, error_message,
       triggered_by_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      params.status,
      params.errorMessage ?? null,
      params.triggeredByRunId ?? null,
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
  return runId;
}

export function listRuns(db: Database, mappingId?: number | null): RunSummary[] {
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
