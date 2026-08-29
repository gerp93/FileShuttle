/// <reference types="vite/client" />

import type {
  CreateMappingInput,
  DbLocationInfo,
  FileOutcome,
  MappingRecord,
  RunAllSummary,
  RunResult,
  RunStats,
  RunSummary,
  UpdateCheckResult,
  UpdateMappingInput,
} from '../shared/types';

interface FileShuttleAPI {
  mappings: {
    list: () => Promise<MappingRecord[]>;
    get: (id: number) => Promise<MappingRecord | null>;
    create: (input: CreateMappingInput) => Promise<number>;
    update: (id: number, input: UpdateMappingInput) => Promise<void>;
    delete: (id: number) => Promise<void>;
    setEnabled: (id: number, enabled: boolean) => Promise<void>;
    getStats: (id: number) => Promise<RunStats>;
    run: (id: number) => Promise<RunResult>;
    runAll: () => Promise<RunAllSummary>;
  };
  history: {
    list: (mappingId?: number | null) => Promise<RunSummary[]>;
    getDetail: (runId: number) => Promise<FileOutcome[]>;
    undo: (runId: number) => Promise<RunResult>;
  };
  settings: {
    getTheme: () => Promise<string | null>;
    setTheme: (themeId: string) => Promise<void>;
    getStartup: () => Promise<{ supported: boolean; enabled: boolean }>;
    setStartup: (enabled: boolean) => Promise<void>;
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
