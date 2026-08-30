import { contextBridge, ipcRenderer } from 'electron';
import {
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

export interface FileShuttleAPI {
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

const api: FileShuttleAPI = {
  mappings: {
    list: () => ipcRenderer.invoke('mappings:list'),
    get: (id) => ipcRenderer.invoke('mappings:get', id),
    create: (input) => ipcRenderer.invoke('mappings:create', input),
    update: (id, input) => ipcRenderer.invoke('mappings:update', id, input),
    delete: (id) => ipcRenderer.invoke('mappings:delete', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('mappings:setEnabled', id, enabled),
    getStats: (id) => ipcRenderer.invoke('mappings:getStats', id),
    run: (id) => ipcRenderer.invoke('mappings:run', id),
    runAll: () => ipcRenderer.invoke('mappings:runAll'),
  },
  history: {
    list: (mappingId) => ipcRenderer.invoke('history:list', mappingId),
    getDetail: (runId) => ipcRenderer.invoke('history:getDetail', runId),
    undo: (runId) => ipcRenderer.invoke('history:undo', runId),
  },
  settings: {
    getTheme: () => ipcRenderer.invoke('settings:getTheme'),
    setTheme: (themeId) => ipcRenderer.invoke('settings:setTheme', themeId),
    getStartup: () => ipcRenderer.invoke('settings:getStartup'),
    setStartup: (enabled) => ipcRenderer.invoke('settings:setStartup', enabled),
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
