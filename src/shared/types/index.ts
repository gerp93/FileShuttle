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

export const ACTION_TYPES = ['move', 'copy', 'delete', 'zip', 'unzip'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SCHEDULE_TYPES = ['manual', 'interval', 'daily_at', 'watch'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export interface FilterRule {
  field: FilterField;
  operator: FilterOperator;
  value: string;
  /**
   * Rules sharing a group are OR'd (any one is enough); different groups are
   * AND'd (every group must be satisfied). A rule alone in its group is a plain condition.
   */
  group: number;
}

export interface MappingConfig {
  id: number;
  name: string;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  conflictPolicy: ConflictPolicy;
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
  /** Set when the run was stopped early by the user. Not stored in history. */
  cancelled?: boolean;
}

export interface MappingRecord {
  id: number;
  name: string;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  actionType: ActionType;
  conflictPolicy: ConflictPolicy;
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
  nextMappingId: number | null;
  actionType: ActionType;
  keepNewest: number | null;
}

export type UpdateMappingInput = CreateMappingInput;

export type FolderRole = 'source' | 'destination';

/**
 * Result of checking a typed folder path. `ok` and `will_create` are usable;
 * `missing` is a warning (an unplugged drive is a legitimate thing to configure);
 * `invalid` and `not_folder` can never work.
 */
export interface FolderCheck {
  status: 'ok' | 'will_create' | 'missing' | 'not_folder' | 'invalid';
  message: string | null;
}

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
  /** Every HH:MM the job runs at when scheduleType is 'daily_at'; sorted, no duplicates. Empty otherwise. */
  scheduleDailyTimes: string[];
  createdAt: string;
  updatedAt: string;
  /** Run once on start-up/wake if the schedule was missed while the app wasn't running. */
  catchUp: boolean;
  /** When the job last ran to completion (ISO); null if it never has. */
  lastRunAt: string | null;
  steps: MappingRecord[];
}

export interface CreateJobInput {
  name: string;
  enabled: boolean;
  catchUp?: boolean;
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleDailyTimes: string[];
  mappingIds: number[];
}

export type UpdateJobInput = CreateJobInput;

export interface HistoryListFilter {
  mappingId?: number | null;
  jobId?: number | null;
}

/** A mapping that deletes files, or can replace files that already exist at the destination. */
export function isDestructiveMapping(mapping: { actionType: ActionType; conflictPolicy: ConflictPolicy }): boolean {
  return mapping.actionType === 'delete' || mapping.conflictPolicy === 'overwrite';
}

/** Plain-language form of a FileOutcome.reason for display. */
export function outcomeReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'kept_newest':
      return 'kept (newest)';
    case 'conflict_skip':
      return 'already exists at destination';
    case 'conflict_overwrite':
      return 'replaces the existing file';
    case 'conflict_auto_rename':
      return 'renamed to keep both';
    default:
      return reason;
  }
}

/** Preview results carry at most this many per-file rows over IPC; the counts always cover every file. */
export const PREVIEW_OUTCOME_LIMIT = 2000;

export interface StepPreview {
  mappingId: number;
  mappingName: string;
  actionType: ActionType;
  /** Counts are for every matching file; `fileOutcomes` may be cut to PREVIEW_OUTCOME_LIMIT rows. */
  result: RunResult;
  totalOutcomes: number;
  truncated: boolean;
  /** Bytes of the files that would be moved/copied/deleted/zipped/extracted. */
  totalBytes: number;
  /** How many of those would replace a file that already exists at the destination. */
  overwriteCount: number;
}

export interface JobPreview {
  jobId: number;
  jobName: string;
  steps: StepPreview[];
}

/** Live status of a job run, pushed to the UI while it works. `finished` means the card should reset. */
export interface RunProgressEvent {
  jobId: number;
  jobName: string;
  phase: 'queued' | 'scanning' | 'processing' | 'finished';
  /** 1-based position among the job's enabled steps. */
  stepIndex: number;
  stepCount: number;
  stepName: string;
  scanned: number;
  processed: number;
  total: number | null;
}

/** Bounds on what unzip will extract, so a hostile or accidental "zip bomb" can't fill the disk. */
export interface UnzipLimitsSetting {
  maxEntries: number;
  maxTotalGB: number;
}

export const DEFAULT_UNZIP_LIMITS_SETTING: UnzipLimitsSetting = { maxEntries: 100_000, maxTotalGB: 20 };

/** Returns a problem with the proposed limits, or null when they are acceptable. */
export function validateUnzipLimits(limits: UnzipLimitsSetting): string | null {
  if (!Number.isInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 10_000_000) {
    return 'The entry limit must be a whole number between 1 and 10,000,000.';
  }
  if (!Number.isFinite(limits.maxTotalGB) || limits.maxTotalGB <= 0 || limits.maxTotalGB > 4096) {
    return 'The size limit must be greater than 0 and at most 4096 GB.';
  }
  return null;
}
