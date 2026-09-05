/// <reference types="vite/client" />

import type {
  CreateJobInput,
  CreateMappingInput,
  DbLocationInfo,
  FileOutcome,
  HistoryListFilter,
  JobRecord,
  JobRef,
  LogRetentionId,
  MappingRecord,
  PurgeResult,
  RunAllSummary,
  RunResult,
  RunStats,
  RunSummary,
  UpdateCheckResult,
  UpdateJobInput,
  UpdateMappingInput,
} from '../shared/types';

interface FileShuttleAPI {
  mappings: {
    list: () => Promise<MappingRecord[]>;
    get: (id: number) => Promise<MappingRecord | null>;
    create: (input: CreateMappingInput) => Promise<number>;
    update: (id: number, input: UpdateMappingInput) => Promise<void>;
    delete: (id: number) => Promise<void>;
    clone: (id: number, name: string) => Promise<number>;
    setEnabled: (id: number, enabled: boolean) => Promise<void>;
    getStats: (id: number) => Promise<RunStats>;
    listJobsUsing: (id: number) => Promise<JobRef[]>;
  };
  jobs: {
    list: () => Promise<JobRecord[]>;
    get: (id: number) => Promise<JobRecord | null>;
    create: (input: CreateJobInput) => Promise<number>;
    update: (id: number, input: UpdateJobInput) => Promise<void>;
    delete: (id: number) => Promise<void>;
    setEnabled: (id: number, enabled: boolean) => Promise<void>;
    getStats: (id: number) => Promise<RunStats>;
    run: (id: number) => Promise<RunResult>;
    runAll: () => Promise<RunAllSummary>;
  };
  history: {
    list: (filter?: HistoryListFilter | number | null) => Promise<RunSummary[]>;
    getDetail: (runId: number) => Promise<FileOutcome[]>;
    undo: (runId: number) => Promise<RunResult>;
    purgeAll: () => Promise<PurgeResult>;
  };
  settings: {
    getTheme: () => Promise<string | null>;
    setTheme: (themeId: string) => Promise<void>;
    getStartup: () => Promise<{ supported: boolean; enabled: boolean }>;
    setStartup: (enabled: boolean) => Promise<void>;
    getLogRetention: () => Promise<LogRetentionId>;
    setLogRetention: (id: LogRetentionId) => Promise<PurgeResult>;
  };
  dialogs: {
    pickFolder: (title: string) => Promise<string | null>;
  };
  shell: {
    openPath: (filePath: string) => Promise<string>;
  };
  dbLocation: {
    get: () => Promise<DbLocationInfo>;
    browseExisting: () => Promise<string | null>;
    browseNew: () => Promise<string | null>;
    set: (newPath: string) => Promise<{ success: boolean }>;
    resetToDefault: () => Promise<{ success: boolean }>;
  };
  app: {
    getVersion: () => Promise<string>;
  };
  updates: {
    check: () => Promise<UpdateCheckResult>;
  };
}

declare global {
  interface Window {
    fileshuttleAPI: FileShuttleAPI;
  }
}

export {};
