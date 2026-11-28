import { randomUUID } from 'crypto';
import { computeRunStatus, JobRecord, RunProgressEvent, RunResult } from '../../shared/types';
import type { FileOutcome, MappingConfig } from '../../shared/types';
import type { UndoCommand, WorkerToHub } from '../../shared/workerProtocol';
import { toMappingConfig } from '../database/repository';
import type { RunSettings } from '../settings/appSettings';
import { RunProgress, runMapping } from '../engine/mover';
import { undoRun } from '../engine/undo';

/** Thrown when a run is requested for a job that is already running (or queued to run). */
export class JobAlreadyRunningError extends Error {
  constructor(public readonly jobId: number) {
    super('This job is already running. Wait for it to finish, then try again.');
    this.name = 'JobAlreadyRunningError';
  }
}

/** A worker-side check on which folders may be touched (a remote worker's allowed list). */
export interface FolderGuard {
  /** A sentence saying why a mapping's folders are refused, or null when they are fine. */
  problemWithMapping(config: Pick<MappingConfig, 'sourcePath' | 'destPath' | 'actionType'>): Promise<string | null>;
  /** The same for every path an undo would touch. */
  problemWithOutcomes(outcomes: readonly FileOutcome[]): Promise<string | null>;
}

/** What the executor needs from the worker around it. It touches no database. */
export interface ExecutorDeps {
  workerId: string;
  /** The job as the worker's schedule copy knows it. */
  getJob: (jobId: number) => JobRecord | null;
  /** The only settings a run reads. */
  readRunSettings: () => RunSettings;
  /** Sends a report to the hub. */
  emit: (message: WorkerToHub) => void;
  /** Present on a remote worker: refuses folders outside its allowed list. */
  guard?: FolderGuard;
}

/**
 * Runs jobs. Two runs touching the same folders at once would race each other (both see the
 * same file, one moves it out from under the other, conflicts get mis-resolved). So:
 *   - a given job can only be queued/running once at a time, and
 *   - all runs (and undos) execute one after another, never in parallel.
 *
 * It reports every step as it happens (runStarted, progress, runFinished, jobFinished); writing
 * the history is the hub's job, never the executor's.
 */
export class RunExecutor {
  private activeJobs = new Map<number, AbortController>();
  private queueTail: Promise<unknown> = Promise.resolve();

  constructor(private deps: ExecutorDeps) {}

  isJobActive(jobId: number): boolean {
    return this.activeJobs.has(jobId);
  }

  /** Asks a queued or running job to stop before its next file. Work already done is kept. */
  cancelJob(jobId: number): boolean {
    const controller = this.activeJobs.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(task, task);
    this.queueTail = result.catch(() => undefined);
    return result;
  }

  private progress(event: RunProgressEvent): void {
    this.deps.emit({ type: 'progress', workerId: this.deps.workerId, event });
  }

  async runJob(jobId: number, triggerType: 'manual' | 'scheduled'): Promise<RunResult> {
    if (this.activeJobs.has(jobId)) {
      throw new JobAlreadyRunningError(jobId);
    }
    const controller = new AbortController();
    this.activeJobs.set(jobId, controller);
    const blank = { jobId, jobName: '', stepIndex: 0, stepCount: 0, stepName: '', scanned: 0, processed: 0, total: null };
    this.progress({ ...blank, phase: 'queued' });
    try {
      return await this.runExclusive(async () => {
        const job = this.deps.getJob(jobId);
        if (!job) {
          throw new Error(`No job with id ${jobId}`);
        }
        if (controller.signal.aborted) return { ...aggregateResults([]), cancelled: true };
        const startedAt = new Date().toISOString();
        const results = await this.runJobSteps(job, triggerType, controller.signal);
        // The hub remembers when it last ran in full, so a missed schedule can be caught up
        // after the app was closed or the PC asleep. A cancelled run doesn't count.
        const completed = results.length > 0 && !controller.signal.aborted;
        this.deps.emit({ type: 'jobFinished', workerId: this.deps.workerId, jobId, startedAt, completed });
        const aggregated = aggregateResults(results);
        return controller.signal.aborted ? { ...aggregated, cancelled: true } : aggregated;
      });
    } finally {
      this.activeJobs.delete(jobId);
      this.progress({ ...blank, phase: 'finished' });
    }
  }

  private async runJobSteps(
    job: JobRecord,
    triggerType: 'manual' | 'scheduled',
    signal: AbortSignal
  ): Promise<RunResult[]> {
    const { workerId } = this.deps;
    const results: RunResult[] = [];
    let triggeredByRunUid: string | null = null;
    const steps = job.steps.filter((step) => step.enabled);

    for (const [index, mapping] of steps.entries()) {
      if (signal.aborted) break;
      // Read per step so flipping a setting takes effect for the next step.
      const settings = this.deps.readRunSettings();
      const runUid = randomUUID();
      this.deps.emit({
        type: 'runStarted',
        workerId,
        runUid,
        jobId: job.id,
        mappingId: mapping.id,
        startedAt: new Date().toISOString(),
      });
      const progress = (phase: 'scanning' | 'processing', p: RunProgress) =>
        this.progress({
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
      const mappingConfig = toMappingConfig(mapping);
      const refused = this.deps.guard ? await this.deps.guard.problemWithMapping(mappingConfig) : null;
      if (refused) {
        // Nothing is touched. The step is reported as an error with the reason, and the chain stops.
        const nothing = aggregateResults([]);
        this.deps.emit({
          type: 'runFinished',
          workerId,
          runUid,
          mappingId: mapping.id,
          mappingNameSnapshot: mapping.name,
          jobId: job.id,
          jobNameSnapshot: job.name,
          triggerType,
          status: 'error',
          errorMessage: refused,
          triggeredByRunUid,
          undoesRunUid: null,
          result: nothing,
        });
        results.push(nothing);
        break;
      }
      const result = await runMapping(mappingConfig, {
        backupOverwritten: settings.overwriteBackup,
        unzipLimits: settings.unzipLimits,
        signal,
        onProgress: (p) => progress(p.phase, p),
      });
      // Each step is reported (and so written to history) before the next step starts, so if the
      // app dies between steps the files already moved still have a history row (and so can be
      // undone) instead of vanishing without a trace.
      this.deps.emit({
        type: 'runFinished',
        workerId,
        runUid,
        mappingId: mapping.id,
        mappingNameSnapshot: mapping.name,
        jobId: job.id,
        jobNameSnapshot: job.name,
        triggerType,
        status: computeRunStatus(result),
        errorMessage: null,
        triggeredByRunUid,
        undoesRunUid: null,
        result,
      });
      results.push(result);
      triggeredByRunUid = runUid;
    }

    return results;
  }

  /** Reverses a run. The undo is reported as a run of its own (trigger 'undo'). */
  undo(command: UndoCommand): Promise<RunResult> {
    return this.runExclusive(async () => {
      const refused = this.deps.guard ? await this.deps.guard.problemWithOutcomes(command.fileOutcomes) : null;
      if (refused) throw new Error(refused);
      const result = await undoRun(command.fileOutcomes, {
        window: { startedAt: command.startedAt, finishedAt: command.finishedAt },
        originalWasUndo: command.originalWasUndo,
      });
      this.deps.emit({
        type: 'runFinished',
        workerId: this.deps.workerId,
        runUid: randomUUID(),
        mappingId: command.mappingId,
        mappingNameSnapshot: command.mappingNameSnapshot,
        jobId: command.jobId,
        jobNameSnapshot: command.jobNameSnapshot,
        triggerType: 'undo',
        status: computeRunStatus(result),
        errorMessage: null,
        triggeredByRunUid: null,
        undoesRunUid: command.originalRunUid,
        result,
      });
      return result;
    });
  }
}

export function aggregateResults(results: RunResult[]): RunResult {
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
