import { contextBridge, ipcRenderer } from 'electron';
import {
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

export interface FileShuttleAPI {
  mappings: {
    list: () => Promise<MappingRecord[]>;
    get: (id: number) => Promise<MappingRecord | null>;
    create: (input: CreateMappingInput) => Promise<number>;
    update: (id: number, input: UpdateMappingInput) => Promise<void>;
    delete: (id: number) => Promise<void>;
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

const api: FileShuttleAPI = {
  mappings: {
    list: () => ipcRenderer.invoke('mappings:list'),
    get: (id) => ipcRenderer.invoke('mappings:get', id),
    create: (input) => ipcRenderer.invoke('mappings:create', input),
    update: (id, input) => ipcRenderer.invoke('mappings:update', id, input),
    delete: (id) => ipcRenderer.invoke('mappings:delete', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('mappings:setEnabled', id, enabled),
    getStats: (id) => ipcRenderer.invoke('mappings:getStats', id),
    listJobsUsing: (id) => ipcRenderer.invoke('mappings:listJobsUsing', id),
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    get: (id) => ipcRenderer.invoke('jobs:get', id),
    create: (input) => ipcRenderer.invoke('jobs:create', input),
    update: (id, input) => ipcRenderer.invoke('jobs:update', id, input),
    delete: (id) => ipcRenderer.invoke('jobs:delete', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('jobs:setEnabled', id, enabled),
    getStats: (id) => ipcRenderer.invoke('jobs:getStats', id),
    run: (id) => ipcRenderer.invoke('jobs:run', id),
    runAll: () => ipcRenderer.invoke('jobs:runAll'),
  },
  history: {
    list: (filter) => ipcRenderer.invoke('history:list', filter),
    getDetail: (runId) => ipcRenderer.invoke('history:getDetail', runId),
    undo: (runId) => ipcRenderer.invoke('history:undo', runId),
    purgeAll: () => ipcRenderer.invoke('history:purgeAll'),
  },
  settings: {
    getTheme: () => ipcRenderer.invoke('settings:getTheme'),
    setTheme: (themeId) => ipcRenderer.invoke('settings:setTheme', themeId),
    getStartup: () => ipcRenderer.invoke('settings:getStartup'),
    setStartup: (enabled) => ipcRenderer.invoke('settings:setStartup', enabled),
    getLogRetention: () => ipcRenderer.invoke('settings:getLogRetention'),
    setLogRetention: (id) => ipcRenderer.invoke('settings:setLogRetention', id),
  },
  dialogs: {
    pickFolder: (title) => ipcRenderer.invoke('dialogs:pickFolder', title),
  },
  shell: {
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },
  dbLocation: {
    get: () => ipcRenderer.invoke('dbLocation:get'),
    browseExisting: () => ipcRenderer.invoke('dbLocation:browseExisting'),
    browseNew: () => ipcRenderer.invoke('dbLocation:browseNew'),
    set: (newPath) => ipcRenderer.invoke('dbLocation:set', newPath),
    resetToDefault: () => ipcRenderer.invoke('dbLocation:resetToDefault'),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
  },
};

contextBridge.exposeInMainWorld('fileshuttleAPI', api);

declare global {
  interface Window {
    fileshuttleAPI: FileShuttleAPI;
  }
}
