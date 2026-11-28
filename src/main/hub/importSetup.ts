import type { Database } from '../database/sqlite';
import { transaction } from '../database/sqlite';
import { queryAll } from '../database/dbHelpers';
import { createJob, createMapping, updateMapping } from '../database/repository';
import { validateJobInput } from '../../shared/schedule';
import { validateMappingInput } from '../../shared/validation';
import {
  ACTION_TYPES,
  CONFLICT_POLICIES,
  CreateJobInput,
  CreateMappingInput,
  FILTER_FIELDS,
  FILTER_OPERATORS,
  FilterRule,
  SCHEDULE_TYPES,
} from '../../shared/types';

/**
 * "Send my existing setup to the hub": a desktop app that switches to a remote hub offers to send
 * its jobs and mappings once. This is the hub's side. Everything arrives as untrusted JSON from
 * an authenticated worker, so each field is checked here and nothing is taken on trust.
 *
 * Rules: the mappings land on the sending machine only; a name the machine already has is skipped
 * (never replaced); chain links and job steps are re-pointed at the new ids; every imported job is
 * saved switched off, so nothing runs on the new machine until its owner has set the allowed
 * folders and switched the job on.
 */

export const MAX_SETUP_MAPPINGS = 500;
export const MAX_SETUP_JOBS = 200;

export interface SetupMapping extends Omit<CreateMappingInput, 'workerId' | 'nextMappingId'> {
  /** The id on the sending computer; only used to re-point chains and job steps. */
  sourceId: number;
  /** The sending computer's id of the mapping this one chains into. */
  nextSourceId: number | null;
}

export interface SetupJob extends Omit<CreateJobInput, 'mappingIds' | 'enabled'> {
  /** The sending computer's ids of the steps, in order. */
  stepSourceIds: number[];
}

export interface SetupPayload {
  mappings: SetupMapping[];
  jobs: SetupJob[];
}

export interface SkippedItem {
  name: string;
  reason: string;
}

export interface ImportReport {
  ok: true;
  mappingsSent: number;
  mappingsSkipped: SkippedItem[];
  jobsSent: number;
  jobsSkipped: SkippedItem[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function intOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function parseFilters(value: unknown): FilterRule[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const out: FilterRule[] = [];
  for (const item of value) {
    if (!isObject(item)) return null;
    const value_ = str(item.value, 2000);
    if (
      value_ === null ||
      !(FILTER_FIELDS as readonly unknown[]).includes(item.field) ||
      !(FILTER_OPERATORS as readonly unknown[]).includes(item.operator) ||
      typeof item.group !== 'number' ||
      !Number.isInteger(item.group)
    ) {
      return null;
    }
    out.push({ field: item.field as FilterRule['field'], operator: item.operator as FilterRule['operator'], value: value_, group: item.group });
  }
  return out;
}

/** Checks the shape of the payload. Returns the cleaned payload, or a sentence saying what is wrong. */
export function parseSetupPayload(input: unknown): SetupPayload | string {
  if (!isObject(input) || !Array.isArray(input.mappings) || !Array.isArray(input.jobs)) return 'The setup is not in the expected form.';
  if (input.mappings.length > MAX_SETUP_MAPPINGS) return `At most ${MAX_SETUP_MAPPINGS} mappings can be sent at once.`;
  if (input.jobs.length > MAX_SETUP_JOBS) return `At most ${MAX_SETUP_JOBS} jobs can be sent at once.`;

  const mappings: SetupMapping[] = [];
  for (const m of input.mappings) {
    if (!isObject(m)) return 'A mapping in the setup is not in the expected form.';
    const name = str(m.name, 300);
    const sourcePath = str(m.sourcePath, 4000);
    const destPath = str(m.destPath, 4000);
    const dailyTime = m.scheduleDailyTime === null || m.scheduleDailyTime === undefined ? null : str(m.scheduleDailyTime, 10);
    const interval = intOrNull(m.scheduleIntervalMinutes);
    const keepNewest = intOrNull(m.keepNewest);
    const filters = parseFilters(m.filters ?? []);
    const sourceId = m.sourceId;
    const nextSourceId = intOrNull(m.nextSourceId);
    if (
      name === null ||
      sourcePath === null ||
      destPath === null ||
      filters === null ||
      interval === undefined ||
      keepNewest === undefined ||
      nextSourceId === undefined ||
      typeof sourceId !== 'number' ||
      !Number.isInteger(sourceId) ||
      typeof m.recursive !== 'boolean' ||
      !(ACTION_TYPES as readonly unknown[]).includes(m.actionType) ||
      !(CONFLICT_POLICIES as readonly unknown[]).includes(m.conflictPolicy) ||
      !(SCHEDULE_TYPES as readonly unknown[]).includes(m.scheduleType) ||
      (m.scheduleDailyTime != null && dailyTime === null)
    ) {
      return `The mapping “${typeof m.name === 'string' ? m.name.slice(0, 60) : '?'}” is not in the expected form.`;
    }
    mappings.push({
      sourceId,
      nextSourceId,
      name,
      sourcePath,
      destPath,
      recursive: m.recursive,
      conflictPolicy: m.conflictPolicy as SetupMapping['conflictPolicy'],
      enabled: m.enabled === true,
      scheduleType: m.scheduleType as SetupMapping['scheduleType'],
      scheduleIntervalMinutes: interval,
      scheduleDailyTime: dailyTime,
      filters,
      actionType: m.actionType as SetupMapping['actionType'],
      keepNewest,
      keepNewestPerExtension: m.keepNewestPerExtension === true,
    });
  }

  const jobs: SetupJob[] = [];
  for (const j of input.jobs) {
    if (!isObject(j)) return 'A job in the setup is not in the expected form.';
    const name = str(j.name, 300);
    const interval = intOrNull(j.scheduleIntervalMinutes);
    const times = Array.isArray(j.scheduleDailyTimes) && j.scheduleDailyTimes.length <= 48 && j.scheduleDailyTimes.every((t) => typeof t === 'string' && t.length <= 10)
      ? (j.scheduleDailyTimes as string[])
      : null;
    const steps = Array.isArray(j.stepSourceIds) && j.stepSourceIds.length <= 100 && j.stepSourceIds.every((n) => typeof n === 'number' && Number.isInteger(n))
      ? (j.stepSourceIds as number[])
      : null;
    if (name === null || interval === undefined || times === null || steps === null || !(SCHEDULE_TYPES as readonly unknown[]).includes(j.scheduleType)) {
      return `The job “${typeof j.name === 'string' ? j.name.slice(0, 60) : '?'}” is not in the expected form.`;
    }
    jobs.push({
      name,
      catchUp: j.catchUp === true,
      scheduleType: j.scheduleType as SetupJob['scheduleType'],
      scheduleIntervalMinutes: interval,
      scheduleDailyTimes: times,
      stepSourceIds: steps,
    });
  }
  return { mappings, jobs };
}

function namesOf(db: Database, table: 'mappings' | 'jobs', workerId: string): Set<string> {
  return new Set(queryAll(db, `SELECT name FROM ${table} WHERE worker_id = ?`, [workerId]).map((r) => String(r.name).trim().toLowerCase()));
}

/**
 * Puts the payload on the given worker, all or nothing. Returns what was added and what was left
 * out, with a plain reason for each skipped item.
 */
export function importSetup(db: Database, workerId: string, payload: SetupPayload): ImportReport {
  return transaction(db, () => {
    const mappingNames = namesOf(db, 'mappings', workerId);
    const jobNames = namesOf(db, 'jobs', workerId);
    const newIds = new Map<number, number>(); // sending computer's id -> hub id
    const mappingsSkipped: SkippedItem[] = [];
    const skippedSources = new Map<number, string>();
    const created: SetupMapping[] = [];

    for (const m of payload.mappings) {
      const key = m.name.trim().toLowerCase();
      if (mappingNames.has(key)) {
        mappingsSkipped.push({ name: m.name, reason: 'This machine already has a mapping with that name.' });
        skippedSources.set(m.sourceId, 'a mapping it uses was skipped');
        continue;
      }
      const input: CreateMappingInput = { ...m, nextMappingId: null, workerId };
      const problem = validateMappingInput(input);
      if (problem) {
        mappingsSkipped.push({ name: m.name, reason: problem });
        skippedSources.set(m.sourceId, 'a mapping it uses was skipped');
        continue;
      }
      // A mapping only runs as a step of a job, and every imported job is switched off.
      newIds.set(m.sourceId, createMapping(db, input, workerId));
      mappingNames.add(key);
      created.push(m);
    }

    // Chain links go in second, now that every new mapping has its id.
    for (const m of created) {
      if (m.nextSourceId == null) continue;
      const next = newIds.get(m.nextSourceId);
      const id = newIds.get(m.sourceId) as number;
      if (next == null) continue; // the chain target was skipped or not sent: the step ends the chain
      const input: CreateMappingInput = { ...m, nextMappingId: next, workerId };
      updateMapping(db, id, input);
    }

    const jobsSkipped: SkippedItem[] = [];
    let jobsSent = 0;
    for (const j of payload.jobs) {
      const key = j.name.trim().toLowerCase();
      if (jobNames.has(key)) {
        jobsSkipped.push({ name: j.name, reason: 'This machine already has a job with that name.' });
        continue;
      }
      const mappingIds: number[] = [];
      let missing: string | null = null;
      for (const sourceId of j.stepSourceIds) {
        const id = newIds.get(sourceId);
        if (id == null) {
          missing = skippedSources.get(sourceId) ?? 'a mapping it uses was not sent';
          break;
        }
        mappingIds.push(id);
      }
      if (missing) {
        jobsSkipped.push({ name: j.name, reason: `Left out because ${missing}.` });
        continue;
      }
      const input: CreateJobInput = {
        name: j.name,
        enabled: false,
        catchUp: j.catchUp,
        scheduleType: j.scheduleType,
        scheduleIntervalMinutes: j.scheduleIntervalMinutes,
        scheduleDailyTimes: j.scheduleDailyTimes,
        mappingIds,
      };
      const problem = validateJobInput(input);
      if (problem) {
        jobsSkipped.push({ name: j.name, reason: problem });
        continue;
      }
      createJob(db, input, workerId);
      jobNames.add(key);
      jobsSent += 1;
    }
    return { ok: true as const, mappingsSent: created.length, mappingsSkipped, jobsSent, jobsSkipped };
  });
}
