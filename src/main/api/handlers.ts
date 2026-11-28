import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import type { Hub } from '../hub/hub';
import { createPairingCode } from '../hub/pairing';
import { getWorker, listQueuedRuns, listWorkers, revokeWorker, workerLoad } from '../database/workers';
import { versionNotice } from '../../shared/versionNotice';
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
  PairCodeInfo,
  UpdateMappingInput,
  validateUnzipLimits,
  WorkerInfo,
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
      return deps.hub.previewMapping(repo.toMappingConfig(mapping), mapping.workerId);
    },

    // Previews the editor's current, possibly unsaved, form values.
    'mappings:previewInput': async (input: CreateMappingInput) => {
      assertValidMapping(input);
      return deps.hub.previewMapping(inputToConfig(input), input.workerId);
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

    // The machine is optional: with none, this computer's own worker answers.
    'dialogs:checkFolder': (folder: string, role: FolderRole, workerId?: string) =>
      deps.hub.checkFolder(folder, role, workerId || undefined),

    // The phone has no native folder picker; the page browses with this instead.
    'dialogs:listFolder': (folder?: string | null, workerId?: string) => deps.hub.listFolder(folder, workerId || undefined),

    // Machines (workers) -----------------------------------------------------

    'workers:list': (): WorkerInfo[] => {
      const queued = listQueuedRuns(db());
      return listWorkers(db()).map((worker) => {
        const load = workerLoad(db(), worker.id);
        return {
          id: worker.id,
          name: worker.name,
          kind: worker.kind,
          platform: worker.platform,
          appVersion: worker.appVersion,
          online: deps.hub.isOnline(worker.id),
          lastSeenAt: worker.lastSeenAt,
          versionNotice: worker.kind === 'remote' ? versionNotice(worker.appVersion, deps.getVersion()) : null,
          mappingCount: load.mappings,
          jobCount: load.jobs,
          queuedRunCount: queued.filter((q) => q.workerId === worker.id).length,
        };
      });
    },

    // A one-time code to pair a machine. Only its hash is kept.
    'workers:createPairCode': (): PairCodeInfo => createPairingCode(db()),

    // Removing a machine cuts it off for good (its token is deleted and its connection closed). The row
    // stays because run history points at it. A machine that still owns mappings or jobs is not removed
    // (the safer choice: nothing is deleted behind the person's back); delete those first.
    'workers:remove': (workerId: string) => {
      const worker = getWorker(db(), workerId);
      if (!worker || worker.removedAt) throw new Error('That machine is not in the list.');
      if (worker.kind !== 'remote') throw new Error('This computer’s own worker cannot be removed.');
      const load = workerLoad(db(), workerId);
      if (load.mappings > 0 || load.jobs > 0) {
        throw new Error(
          `"${worker.name}" still has ${load.mappings} mapping${load.mappings === 1 ? '' : 's'} and ${load.jobs} job${load.jobs === 1 ? '' : 's'}. Delete them first, then remove the machine.`
        );
      }
      revokeWorker(db(), workerId, new Date().toISOString());
      deps.hub.disconnectWorker(workerId, 'This machine was removed from the hub.');
    },

    'app:getVersion': () => deps.getVersion(),
  };
}
