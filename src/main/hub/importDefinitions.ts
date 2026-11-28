import type { Database } from '../database/sqlite';
import { transaction } from '../database/sqlite';
import { run } from '../database/dbHelpers';
import * as repo from '../database/repository';
import { workerLoad } from '../database/workers';
import { validateJobInput } from '../../shared/schedule';
import { validateMappingInput } from '../../shared/validation';
import type { CreateJobInput, CreateMappingInput, JobRecord, MappingRecord } from '../../shared/types';

/**
 * What a computer that was paired with the hub sends to bring its existing mappings and jobs along
 * (the desktop app's "Send my mappings and jobs to the hub"). Plain data: the same records the
 * app lists, with this computer's own ids, which the hub replaces with its own.
 */
export interface ImportPayload {
  mappings: MappingRecord[];
  jobs: JobRecord[];
  /** Save the jobs switched off, so they can be looked over before anything runs. */
  switchOff?: boolean;
}

export interface ImportResult {
  mappings: number;
  jobs: number;
}

export class ImportError extends Error {}

/** The most one import may carry (an app's whole definition set is a few hundred rows at most). */
export const MAX_IMPORT_ITEMS = 5000;

function toMappingInput(record: MappingRecord, enabled: boolean): CreateMappingInput {
  return {
    name: record.name,
    sourcePath: record.sourcePath,
    destPath: record.destPath,
    recursive: record.recursive,
    conflictPolicy: record.conflictPolicy,
    enabled,
    scheduleType: record.scheduleType,
    scheduleIntervalMinutes: record.scheduleIntervalMinutes,
    scheduleDailyTime: record.scheduleDailyTime,
    filters: record.filters,
    // Chains are re-linked below, once every new id is known.
    nextMappingId: null,
    actionType: record.actionType,
    keepNewest: record.keepNewest,
    keepNewestPerExtension: record.keepNewestPerExtension,
  };
}

/**
 * Creates the mappings and jobs on `workerId` (which runs them from now on, and the hub never runs
 * itself), all or nothing. Refused when that computer already has mappings or jobs on the hub, so
 * an import cannot be repeated into duplicates. A job keeps the time it last ran, so connecting does not
 * make it look overdue and "catch up" run it.
 */
export function importDefinitions(db: Database, workerId: string, payload: ImportPayload): ImportResult {
  if (!payload || !Array.isArray(payload.mappings) || !Array.isArray(payload.jobs)) {
    throw new ImportError('The import must hold a list of mappings and a list of jobs.');
  }
  if (payload.mappings.length + payload.jobs.length > MAX_IMPORT_ITEMS) {
    throw new ImportError(`That is more than ${MAX_IMPORT_ITEMS} mappings and jobs; nothing was imported.`);
  }
  const load = workerLoad(db, workerId);
  if (load.mappings > 0 || load.jobs > 0) {
    throw new ImportError(
      `This machine already has ${load.mappings} mapping(s) and ${load.jobs} job(s) on the hub, so nothing was imported. Delete them first if you want to start over.`
    );
  }
  const off = payload.switchOff === true;
  const known = new Set(payload.mappings.map((m) => m.id));

  // Check everything before writing anything, with the same rules a person saving it would meet.
  for (const mapping of payload.mappings) {
    const problem = validateMappingInput(toMappingInput(mapping, mapping.enabled));
    if (problem) throw new ImportError(`Mapping "${mapping.name}": ${problem}`);
  }
  const jobInputs = payload.jobs.map((job) => {
    const stepIds = job.steps.map((s) => s.id);
    for (const id of stepIds) {
      if (!known.has(id)) throw new ImportError(`Job "${job.name}" uses a mapping that was not sent.`);
    }
    return { job, stepIds };
  });
  for (const { job, stepIds } of jobInputs) {
    const input: CreateJobInput = {
      name: job.name,
      enabled: job.enabled,
      catchUp: job.catchUp,
      scheduleType: job.scheduleType,
      scheduleIntervalMinutes: job.scheduleIntervalMinutes,
      scheduleDailyTimes: job.scheduleDailyTimes,
      mappingIds: stepIds,
    };
    const problem = validateJobInput(input);
    if (problem) throw new ImportError(`Job "${job.name}": ${problem}`);
  }

  return transaction(db, () => {
    const newIds = new Map<number, number>();
    for (const mapping of payload.mappings) {
      newIds.set(mapping.id, repo.createMapping(db, toMappingInput(mapping, mapping.enabled), workerId));
    }
    for (const mapping of payload.mappings) {
      if (mapping.nextMappingId == null) continue;
      const next = newIds.get(mapping.nextMappingId);
      if (next != null) run(db, 'UPDATE mappings SET next_mapping_id = ? WHERE id = ?', [next, newIds.get(mapping.id)!]);
    }
    for (const { job, stepIds } of jobInputs) {
      const id = repo.createJob(
        db,
        {
          name: job.name,
          enabled: off ? false : job.enabled,
          catchUp: job.catchUp,
          scheduleType: job.scheduleType,
          scheduleIntervalMinutes: job.scheduleIntervalMinutes,
          scheduleDailyTimes: job.scheduleDailyTimes,
          mappingIds: stepIds.map((old) => newIds.get(old)!),
        },
        workerId
      );
      if (job.lastRunAt) repo.setJobLastRun(db, id, job.lastRunAt);
    }
    return { mappings: payload.mappings.length, jobs: payload.jobs.length };
  });
}
