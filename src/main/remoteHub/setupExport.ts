import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { getLocalWorkerId } from '../database/workers';
import type { SetupPayload } from '../hub/importSetup';

/**
 * This computer's own jobs and mappings, in the form the hub's import endpoint takes. Run history
 * is never part of it, and the database is only read.
 */
export function buildSetupPayload(db: Database): SetupPayload {
  const workerId = getLocalWorkerId(db);
  const mappings = repo.listMappings(db, false, workerId);
  const jobs = repo.listJobs(db, false, workerId);
  return {
    mappings: mappings.map((m) => ({
      sourceId: m.id,
      nextSourceId: m.nextMappingId,
      name: m.name,
      sourcePath: m.sourcePath,
      destPath: m.destPath,
      recursive: m.recursive,
      conflictPolicy: m.conflictPolicy,
      enabled: m.enabled,
      scheduleType: m.scheduleType,
      scheduleIntervalMinutes: m.scheduleIntervalMinutes,
      scheduleDailyTime: m.scheduleDailyTime,
      filters: m.filters,
      actionType: m.actionType,
      keepNewest: m.keepNewest,
      keepNewestPerExtension: m.keepNewestPerExtension,
    })),
    jobs: jobs.map((j) => ({
      name: j.name,
      catchUp: j.catchUp,
      scheduleType: j.scheduleType,
      scheduleIntervalMinutes: j.scheduleIntervalMinutes,
      scheduleDailyTimes: j.scheduleDailyTimes,
      stepSourceIds: j.steps.map((s) => s.id),
    })),
  };
}
