export const FILTER_FIELDS = [
  'extension',
  'filename_glob',
  'filename_regex',
  'size',
  'modified_date',
  'created_date',
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export const FILTER_OPERATORS = ['equals', 'matches', 'min', 'max', 'before', 'after'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const CONFLICT_POLICIES = ['overwrite', 'skip', 'auto_rename'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export const FILTER_MATCH_MODES = ['all', 'any'] as const;
export type FilterMatchMode = (typeof FILTER_MATCH_MODES)[number];

export const ACTION_TYPES = ['move', 'copy', 'delete', 'zip', 'unzip'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SCHEDULE_TYPES = ['manual', 'interval', 'daily_at', 'watch'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export interface FilterRule {
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export interface MappingConfig {
  id: number;
  name: string;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  conflictPolicy: ConflictPolicy;
  filterMatchMode: FilterMatchMode;
  filters: FilterRule[];
  actionType: ActionType;
  keepNewest: number | null;
}

export interface FileOutcome {
  sourcePath: string;
  destPath: string | null;
  outcome: 'moved' | 'copied' | 'deleted' | 'skipped' | 'error' | 'extracted' | 'zipped';
  reason: string | null;
  sizeBytes: number | null;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  fileOutcomes: FileOutcome[];
  filesMoved: number;
  filesCopied: number;
  filesDeleted: number;
  filesSkipped: number;
  filesErrored: number;
  filesExtracted: number;
  filesZipped: number;
}

export interface MappingRecord {
  id: number;
  name: string;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  actionType: ActionType;
  conflictPolicy: ConflictPolicy;
  filterMatchMode: FilterMatchMode;
  enabled: boolean;
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleDailyTime: string | null;
  createdAt: string;
  updatedAt: string;
  filters: FilterRule[];
  nextMappingId: number | null;
  keepNewest: number | null;
}

export const LOG_RETENTION_PRESETS = [
  { id: '1d', label: '1 day', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '180d', label: '6 months', days: 180 },
  { id: '365d', label: '1 year', days: 365 },
  { id: 'never', label: 'Never delete', days: null },
] as const;

export type LogRetentionId = (typeof LOG_RETENTION_PRESETS)[number]['id'];

export const DEFAULT_LOG_RETENTION: LogRetentionId = '90d';

export interface PurgeResult {
  deletedRuns: number;
}

export const RUN_STATUSES = ['success', 'with_skips', 'partial', 'error'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunCounts = {
  filesMoved: number;
  filesCopied: number;
  filesDeleted: number;
  filesSkipped: number;
  filesErrored: number;
  filesExtracted: number;
  filesZipped: number;
};

/** Success with skipped files is not a failure — it's complete, with a caveat. */
export function computeRunStatus(counts: RunCounts): RunStatus {
  const accomplished =
    counts.filesMoved + counts.filesCopied + counts.filesDeleted + counts.filesExtracted + counts.filesZipped;
  if (counts.filesErrored && !accomplished) return 'error';
  if (counts.filesErrored) return 'partial';
  if (counts.filesSkipped) return 'with_skips';
  return 'success';
}

export function runStatusLabel(status: RunStatus): string {
  if (status === 'with_skips') return 'SUCCESS WITH SKIPS';
  if (status === 'partial') return 'PARTIAL';
  if (status === 'error') return 'ERROR';
  return 'SUCCESS';
}

export function runStatusClass(status: RunStatus): string {
  if (status === 'with_skips') return 'status-skips';
  if (status === 'partial') return 'status-partial';
  if (status === 'error') return 'status-error';
  return 'status-success';
}

export function runStatusMeaning(status: RunStatus): string {
  if (status === 'with_skips') {
    return 'Some files were left in place — already existed at the destination, or kept as newest.';
  }
  if (status === 'partial') return 'Some files succeeded, some failed.';
  if (status === 'error') return 'Nothing succeeded.';
  return 'All matching files were handled.';
}

export interface JobRef {
  id: number;
  name: string;
}

export function mappingInUseMessage(mappingName: string, jobNames: string[]): string {
  if (jobNames.length === 1) {
    return `"${mappingName}" is used by the job "${jobNames[0]}". Remove it from that job first.`;
  }
  const listed = jobNames.map((name) => `"${name}"`).join(', ');
  return `"${mappingName}" is used by the jobs ${listed}. Remove it from those jobs first.`;
}

export interface RunSummary {
  id: number;
  mappingId: number | null;
  mappingNameSnapshot: string;
  jobId: number | null;
  jobNameSnapshot: string | null;
  triggerType: 'manual' | 'scheduled' | 'undo' | 'system';
  startedAt: string;
  finishedAt: string;
  filesMoved: number;
  filesCopied: number;
  filesDeleted: number;
  filesSkipped: number;
  filesErrored: number;
  filesExtracted: number;
  filesZipped: number;
  status: RunStatus;
  errorMessage: string | null;
  undoneByRunId: number | null;
  triggeredByRunId: number | null;
}

export interface CreateMappingInput {
  name: string;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  conflictPolicy: ConflictPolicy;
  enabled: boolean;
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleDailyTime: string | null;
  filters: FilterRule[];
  filterMatchMode: FilterMatchMode;
  nextMappingId: number | null;
  actionType: ActionType;
  keepNewest: number | null;
}

export type UpdateMappingInput = CreateMappingInput;

export interface DbLocationInfo {
  path: string;
  isDefault: boolean;
  defaultPath: string;
}

export interface UpdateCheckResult {
  status: 'available' | 'not-available' | 'error' | 'unsupported';
  version?: string;
  message?: string;
}

export interface RunStats {
  runCount: number;
  lastRun: RunSummary | null;
}

export interface RunAllSummary {
  jobCount: number;
  mappingCount: number;
  filesMoved: number;
  filesSkipped: number;
  filesErrored: number;
}

export interface JobRecord {
  id: number;
  name: string;
  enabled: boolean;
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleDailyTime: string | null;
  createdAt: string;
  updatedAt: string;
  steps: MappingRecord[];
}

export interface CreateJobInput {
  name: string;
  enabled: boolean;
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleDailyTime: string | null;
  mappingIds: number[];
}

export type UpdateJobInput = CreateJobInput;

export interface HistoryListFilter {
  mappingId?: number | null;
  jobId?: number | null;
}
