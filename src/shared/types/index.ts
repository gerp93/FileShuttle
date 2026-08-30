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

export const ACTION_TYPES = ['move', 'copy', 'delete'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const SCHEDULE_TYPES = ['manual', 'interval', 'daily_at'] as const;
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
  outcome: 'moved' | 'copied' | 'deleted' | 'skipped' | 'error';
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

export interface RunSummary {
  id: number;
  mappingId: number;
  mappingNameSnapshot: string;
  jobId: number | null;
  jobNameSnapshot: string | null;
  triggerType: 'manual' | 'scheduled' | 'undo';
  startedAt: string;
  finishedAt: string;
  filesMoved: number;
  filesCopied: number;
  filesDeleted: number;
  filesSkipped: number;
  filesErrored: number;
  status: 'success' | 'partial' | 'error';
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
