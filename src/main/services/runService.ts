import { Database } from 'sql.js';
import { computeRunStatus, JobRecord, RunProgressEvent, RunResult } from '../../shared/types';
import * as repo from '../database/repository';
import { saveDatabase } from '../database/schema';
import { RunProgress, runMapping } from '../engine/mover';
import { undoRun } from '../engine/undo';

export function persistDb(db: Database): void {
  saveDatabase(db);
}

/** Thrown when a run is requested for a job that is already running (or queued to run). */
export class JobAlreadyRunningError extends Error {
  constructor(public readonly jobId: number) {
    super('This job is already running. Wait for it to finish, then try again.');
    this.name = 'JobAlreadyRunningError';
  }
}

// Two runs touching the same folders at once would race each other (both see
// the same file, one moves it out from under the other, conflicts get
// mis-resolved). So:
//   - a given job can only be queued/running once at a time, and
//   - all runs (and undos) execute one after another, never in parallel.
const activeJobs = new Map<number, AbortController>();
const lastProgress = new Map<number, RunProgressEvent>();
let queueTail: Promise<unknown> = Promise.resolve();
let progressListener: ((event: RunProgressEvent) => void) | null = null;

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(task, task);
  queueTail = result.catch(() => undefined);
  return result;
}

export function isJobActive(jobId: number): boolean {
  return activeJobs.has(jobId);
}

/** Registers the one place progress events go (the main process forwards them to the window). */
export function setRunProgressListener(listener: ((event: RunProgressEvent) => void) | null): void {
  progressListener = listener;
}

/** Jobs that are queued or running right now, with their latest progress. */
export function getActiveRuns(): RunProgressEvent[] {
  return [...activeJobs.keys()].map((jobId) => lastProgress.get(jobId)).filter((e): e is RunProgressEvent => !!e);
}

function publish(event: RunProgressEvent): void {
  if (event.phase === 'finished') lastProgress.delete(event.jobId);
  else lastProgress.set(event.jobId, event);
  progressListener?.(event);
}

/** Asks a queued or running job to stop before its next file. Work already done is kept. */
export function cancelJob(jobId: number): boolean {
  const controller = activeJobs.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function executeJob(
  db: Database,
  jobId: number,
  triggerType: 'manual' | 'scheduled'
): Promise<RunResult> {
  if (activeJobs.has(jobId)) {
    throw new JobAlreadyRunningError(jobId);
  }
  const controller = new AbortController();
  activeJobs.set(jobId, controller);
  const blank = { jobId, jobName: '', stepIndex: 0, stepCount: 0, stepName: '', scanned: 0, processed: 0, total: null };
  publish({ ...blank, phase: 'queued' });
  try {
    return await runExclusive(async () => {
      const job = repo.getJob(db, jobId);
      if (!job) {
        throw new Error(`No job with id ${jobId}`);
      }
      if (controller.signal.aborted) return { ...aggregateResults([]), cancelled: true };
      const startedAt = new Date().toISOString();
      const results = await runJobSteps(db, job, triggerType, controller.signal);
      // Remember when it last ran in full, so a missed schedule can be caught up
      // after the app was closed or the PC asleep. A cancelled run doesn't count.
      if (results.length && !controller.signal.aborted) {
        repo.setJobLastRun(db, jobId, startedAt);
        persistDb(db);
      }
      const aggregated = aggregateResults(results);
      return controller.signal.aborted ? { ...aggregated, cancelled: true } : aggregated;
    });
  } finally {
    activeJobs.delete(jobId);
    publish({ ...blank, phase: 'finished' });
  }
}

async function runJobSteps(
  db: Database,
  job: JobRecord,
  triggerType: 'manual' | 'scheduled',
  signal: AbortSignal
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let triggeredByRunId: number | null = null;
  const steps = job.steps.filter((step) => step.enabled);

  for (const [index, mapping] of steps.entries()) {
    if (signal.aborted) break;
    // Read per step so flipping a setting takes effect for the next step.
    const backupOverwritten = repo.getOverwriteBackup(db);
    const unzipLimits = repo.getUnzipLimits(db);
    const progress = (phase: 'scanning' | 'processing', p: RunProgress) =>
      publish({
        jobId: job.id,
        jobName: job.name,
        phase,
        stepIndex: index + 1,
        stepCount: steps.length,
        stepName: mapping.name,
        scanned: p.scanned,
        processed: p.processed,
        total: p.total,
      });
    const result = await runMapping(repo.toMappingConfig(mapping), {
      backupOverwritten,
      unzipLimits,
      signal,
      onProgress: (p) => progress(p.phase, p),
    });
    const status = computeRunStatus(result);
    const runId = repo.recordRun(db, {
      mappingId: mapping.id,
      mappingNameSnapshot: mapping.name,
      triggerType,
      result,
      status,
      triggeredByRunId,
      jobId: job.id,
      jobNameSnapshot: job.name,
    });
    // Save after every step, not once at the end: if the app dies between
    // steps, the files already moved still have a history row (and so can be
    // undone) instead of vanishing without a trace.
    persistDb(db);
    results.push(result);
    triggeredByRunId = runId;
  }

  return results;
}

function aggregateResults(results: RunResult[]): RunResult {
  if (!results.length) {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      fileOutcomes: [],
      filesMoved: 0,
      filesCopied: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      filesErrored: 0,
      filesExtracted: 0,
      filesZipped: 0,
    };
  }
  return {
    startedAt: results[0].startedAt,
    finishedAt: results[results.length - 1].finishedAt,
    fileOutcomes: results.flatMap((r) => r.fileOutcomes),
    filesMoved: results.reduce((sum, r) => sum + r.filesMoved, 0),
    filesCopied: results.reduce((sum, r) => sum + r.filesCopied, 0),
    filesDeleted: results.reduce((sum, r) => sum + r.filesDeleted, 0),
    filesSkipped: results.reduce((sum, r) => sum + r.filesSkipped, 0),
    filesErrored: results.reduce((sum, r) => sum + r.filesErrored, 0),
    filesExtracted: results.reduce((sum, r) => sum + r.filesExtracted, 0),
    filesZipped: results.reduce((sum, r) => sum + r.filesZipped, 0),
  };
}

export function executeUndo(db: Database, runId: number): Promise<RunResult> {
  return runExclusive(async () => {
    const originalRun = repo.getRun(db, runId);
    if (!originalRun) {
      throw new Error(`No run with id ${runId}`);
    }

    const fileOutcomes = repo.getRunDetail(db, runId);
    const result = await undoRun(fileOutcomes, {
      window: { startedAt: originalRun.startedAt, finishedAt: originalRun.finishedAt },
      originalWasUndo: originalRun.triggerType === 'undo',
    });
    const status = computeRunStatus(result);

    const undoRunId = repo.recordRun(db, {
      mappingId: originalRun.mappingId,
      mappingNameSnapshot: `Undo of “${baseMappingName(db, originalRun)}”`,
      triggerType: 'undo',
      result,
      status,
      jobId: originalRun.jobId,
      jobNameSnapshot: originalRun.jobNameSnapshot,
    });
    repo.markRunUndone(db, runId, undoRunId);
    persistDb(db);
    return result;
  });
}

function baseMappingName(db: Database, run: { mappingId: number | null; mappingNameSnapshot: string }): string {
  if (run.mappingId == null) return run.mappingNameSnapshot;
  const record = repo.getMapping(db, run.mappingId);
  if (record) return record.name;
  const snapshot = run.mappingNameSnapshot;
  if (snapshot.startsWith('Undo of “') && snapshot.endsWith('”')) {
    return snapshot.slice('Undo of “'.length, -1);
  }
  return snapshot;
}

/** Runs every enabled job in turn. A job that is already running is skipped, not treated as a failure. */
export async function executeAllEnabledJobs(
  db: Database,
  triggerType: 'manual' | 'scheduled'
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const job of repo.listJobs(db, true)) {
    try {
      results.push(await executeJob(db, job.id, triggerType));
    } catch (err) {
      if (err instanceof JobAlreadyRunningError) continue;
      throw err;
    }
  }
  return results;
}
