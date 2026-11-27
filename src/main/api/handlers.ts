import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import {
  cancelJob,
  executeAllEnabledJobs,
  executeJob,
  executeUndo,
  getActiveRuns,
} from '../services/runService';
import { inputToConfig, previewJob, previewMapping } from '../services/previewService';
import { validateJobInput } from '../../shared/schedule';
import { validateMappingInput } from '../../shared/validation';
import { checkFolder } from '../folderCheck';
import { listFolder } from '../folderBrowse';
import { applyRetention, getLogRetention, setLogRetention } from '../services/retention';
import {
  CreateJobInput,
  CreateMappingInput,
  FolderRole,
  HistoryListFilter,
  LogRetentionId,
  RunAllSummary,
  RunResult,
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

  return {
    'mappings:list': () => repo.listMappings(db()),

    'mappings:get': (id: number) => repo.getMapping(db(), id),

    'mappings:create': (input: CreateMappingInput) => {
      assertValidMapping(input);
      const id = repo.createMapping(db(), input);
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
      return previewMapping(repo.toMappingConfig(mapping), { unzipLimits: repo.getUnzipLimits(db()) });
    },

    // Previews the editor's current, possibly unsaved, form values.
    'mappings:previewInput': async (input: CreateMappingInput) => {
      assertValidMapping(input);
      return previewMapping(inputToConfig(input), { unzipLimits: repo.getUnzipLimits(db()) });
    },

    'mappings:listJobsUsing': (id: number) => repo.listJobsUsingMapping(db(), id),

    'mappings:setEnabled': (id: number, enabled: boolean) => {
      repo.setMappingEnabled(db(), id, enabled);
      changed();
    },

    'mappings:getStats': (id: number) => repo.getRunStats(db(), id),

    'jobs:list': () => repo.listJobs(db()),

    'jobs:get': (id: number) => repo.getJob(db(), id),

    'jobs:create': (input: CreateJobInput) => {
      assertValidJob(input);
      const id = repo.createJob(db(), input);
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

    'jobs:preview': (id: number) => previewJob(db(), id),

    'jobs:cancel': (id: number) => cancelJob(id),

    'jobs:getActive': () => getActiveRuns(),

    'jobs:run': async (id: number): Promise<RunResult> => executeJob(db(), id, 'manual'),

    'jobs:runAll': async (): Promise<RunAllSummary> => {
      const results = await executeAllEnabledJobs(db(), 'manual');
      return {
        jobCount: results.length,
        mappingCount: results.reduce((sum, r) => sum + r.fileOutcomes.length, 0),
        filesMoved: results.reduce((sum, r) => sum + r.filesMoved, 0),
        filesSkipped: results.reduce((sum, r) => sum + r.filesSkipped, 0),
        filesErrored: results.reduce((sum, r) => sum + r.filesErrored, 0),
      };
    },

    'history:list': (filter?: HistoryListFilter | number | null) => repo.listRuns(db(), filter),

    'history:getDetail': (runId: number) => repo.getRunDetail(db(), runId),

    'history:undo': async (runId: number) => executeUndo(db(), runId),

    'history:purgeAll': () => applyRetention(db(), 'all'),

    'settings:getTheme': () => repo.getSetting(db(), 'theme', 'blue_oval'),

    'settings:setTheme': (themeId: string) => {
      repo.setSetting(db(), 'theme', themeId);
    },

    'settings:getOverwriteBackup': () => repo.getOverwriteBackup(db()),

    'settings:setOverwriteBackup': (enabled: boolean) => {
      repo.setOverwriteBackup(db(), enabled);
    },

    'settings:getUnzipLimits': () => repo.getUnzipLimitsSetting(db()),

    'settings:setUnzipLimits': (limits: UnzipLimitsSetting) => {
      const problem = validateUnzipLimits(limits);
      if (problem) throw new Error(problem);
      repo.setUnzipLimitsSetting(db(), limits);
    },

    'settings:getLogRetention': () => getLogRetention(db()),

    'settings:setLogRetention': (id: LogRetentionId) => {
      setLogRetention(db(), id);
      return applyRetention(db(), 'expired');
    },

    'dialogs:checkFolder': (folder: string, role: FolderRole) => checkFolder(folder, role),

    // The phone has no native folder picker; the page browses with this instead.
    'dialogs:listFolder': (folder?: string | null) => listFolder(folder),

    'app:getVersion': () => deps.getVersion(),
  };
}
