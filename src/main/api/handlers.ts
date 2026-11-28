import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { getWorker } from '../database/workers';
import type { Hub } from '../hub/hub';
import { inputToConfig } from '../services/previewService';
import { hubSettings, runSettings } from '../settings/appSettings';
import { validateJobInput } from '../../shared/schedule';
import { validateMappingInput } from '../../shared/validation';
import { applyRetention, getLogRetention, setLogRetention } from '../services/retention';
import {
  CreateJobInput,
  CreateMappingInput,
  FolderRole,
  HistoryListFilter,
  LogRetentionId,
  RunAllSummary,
  UnzipLimitsSetting,
  UpdateJobInput,
  UpdateMappingInput,
  validateUnzipLimits,
} from '../../shared/types';

/** A channel handler: plain arguments in, a result (or a thrown Error) out. No Electron types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (...args: any[]) => unknown;
export type HandlerMap = Record<string, Handler>;

export interface HandlerDeps {
  getDb: () => Database;
  /** Everything that touches folders or runs files goes through the hub, which asks a worker. */
  hub: Hub;
  /** Rebuilds schedules and folder watchers after a mapping or job changed. */
  reloadJobs: () => void;
  getVersion: () => string;
}

/** Rejects a mapping that is incomplete, has an unusable filter, or would feed on its own output. */
function assertValidMapping(input: CreateMappingInput): void {
  const problem = validateMappingInput(input);
  if (problem) throw new Error(problem);
}

/** Rejects a job with no name/steps or an unusable schedule (e.g. a 0-minute interval). */
function assertValidJob(input: CreateJobInput): void {
  const problem = validateJobInput(input);
  if (problem) throw new Error(problem);
}

/**
 * Every handler that works the same from the desktop window (IPC) and from the phone (HTTP).
 * Channel names and return shapes are the ones the renderer has always used.
 */
export function createHandlers(deps: HandlerDeps): HandlerMap {
  const db = () => deps.getDb();
  const changed = () => {
    deps.reloadJobs();
  };
  /** A worker id from the caller, checked; undefined (the default) means this hub's own computer. */
  const knownWorker = (workerId: string | null | undefined): string | undefined => {
    if (workerId == null || workerId === '') return undefined;
    if (!getWorker(db(), String(workerId))) throw new Error('There is no such computer.');
    return String(workerId);
  };

  return {
    'mappings:list': () => repo.listMappings(db()),

    'mappings:get': (id: number) => repo.getMapping(db(), id),

    'mappings:create': (input: CreateMappingInput, workerId?: string) => {
      assertValidMapping(input);
      const id = repo.createMapping(db(), input, knownWorker(workerId));
      changed();
      return id;
    },

    'mappings:update': (id: number, input: UpdateMappingInput) => {
      assertValidMapping(input);
      repo.updateMapping(db(), id, input);
      changed();
    },

    'mappings:delete': (id: number) => {
      repo.deleteMapping(db(), id);
      changed();
    },

    'mappings:clone': (id: number, name: string) => {
      const newId = repo.cloneMapping(db(), id, name);
      changed();
      return newId;
    },

    'mappings:preview': async (id: number) => {
      const mapping = repo.getMapping(db(), id);
      if (!mapping) throw new Error(`No mapping with id ${id}`);
      return deps.hub.previewMapping(repo.toMappingConfig(mapping), mapping.workerId);
    },

    // Previews the editor's current, possibly unsaved, form values.
    'mappings:previewInput': async (input: CreateMappingInput, workerId?: string) => {
      assertValidMapping(input);
      return deps.hub.previewMapping(inputToConfig(input), knownWorker(workerId));
    },

    'mappings:listJobsUsing': (id: number) => repo.listJobsUsingMapping(db(), id),

    'mappings:setEnabled': (id: number, enabled: boolean) => {
      repo.setMappingEnabled(db(), id, enabled);
      changed();
    },

    'mappings:getStats': (id: number) => repo.getRunStats(db(), id),

    'jobs:list': () => repo.listJobs(db()),

    'jobs:get': (id: number) => repo.getJob(db(), id),

    'jobs:create': (input: CreateJobInput, workerId?: string) => {
      assertValidJob(input);
      const id = repo.createJob(db(), input, knownWorker(workerId));
      changed();
      return id;
    },

    'jobs:update': (id: number, input: UpdateJobInput) => {
      assertValidJob(input);
      repo.updateJob(db(), id, input);
      changed();
    },

    'jobs:delete': (id: number) => {
      repo.deleteJob(db(), id);
      changed();
    },

    'jobs:setEnabled': (id: number, enabled: boolean) => {
      repo.setJobEnabled(db(), id, enabled);
      changed();
    },

    'jobs:getStats': (id: number) => repo.getJobStats(db(), id),

    'jobs:preview': (id: number) => deps.hub.previewJob(id),

    'jobs:cancel': (id: number) => deps.hub.cancelJob(id),

    'jobs:getActive': () => deps.hub.getActiveRuns(),

    'jobs:run': async (id: number) => deps.hub.runJob(id, 'manual'),

    'jobs:runAll': async (): Promise<RunAllSummary> => deps.hub.runAll(),

    'history:list': (filter?: HistoryListFilter | number | null) => repo.listRuns(db(), filter),

    'history:getDetail': (runId: number) => repo.getRunDetail(db(), runId),

    'history:undo': async (runId: number) => deps.hub.undo(runId),

    'history:purgeAll': () => applyRetention(db(), 'all'),

    'settings:getTheme': () => hubSettings.getTheme(db()),

    'settings:setTheme': (themeId: string) => {
      hubSettings.setTheme(db(), themeId);
    },

    'settings:getOverwriteBackup': () => runSettings.getOverwriteBackup(db()),

    'settings:setOverwriteBackup': (enabled: boolean) => {
      runSettings.setOverwriteBackup(db(), enabled);
    },

    'settings:getUnzipLimits': () => runSettings.getUnzipLimitsSetting(db()),

    'settings:setUnzipLimits': (limits: UnzipLimitsSetting) => {
      const problem = validateUnzipLimits(limits);
      if (problem) throw new Error(problem);
      runSettings.setUnzipLimitsSetting(db(), limits);
    },

    'settings:getLogRetention': () => getLogRetention(db()),

    'settings:setLogRetention': (id: LogRetentionId) => {
      setLogRetention(db(), id);
      return applyRetention(db(), 'expired');
    },

    'dialogs:checkFolder': (folder: string, role: FolderRole, workerId?: string) =>
      deps.hub.checkFolder(folder, role, knownWorker(workerId)),

    // The phone has no native folder picker; the page browses with this instead.
    'dialogs:listFolder': (folder?: string | null, workerId?: string) => deps.hub.listFolder(folder, knownWorker(workerId)),

    // The computers that move files for this hub, and whether each is online.
    'workers:list': () => deps.hub.listWorkerInfo(),

    'app:getVersion': () => deps.getVersion(),
  };
}
