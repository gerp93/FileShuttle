import { randomUUID } from 'crypto';
import type { Database } from '../database/sqlite';
import {
  FolderRole,
  JobPreview,
  WorkerInfo,
  MappingConfig,
  RunAllSummary,
  RunProgressEvent,
  RunResult,
  StepPreview,
} from '../../shared/types';
import {
  HubCommand,
  HubToWorker,
  isDurableReport,
  RunFinishedMessage,
  WORKER_OFFLINE_AFTER_MS,
  WorkerToHub,
} from '../../shared/workerProtocol';
import * as repo from '../database/repository';
import { queryAll } from '../database/dbHelpers';
import {
  getLocalWorkerId,
  getScheduleVersion,
  isWorkerOnline,
  listWorkers,
  ownerOf,
  recordWorkerHello,
  setScheduleAcked,
  touchWorker,
} from '../database/workers';
import { JobAlreadyRunningError } from '../worker/runExecutor';
import { runSettings } from '../settings/appSettings';

/** The transport as the hub sees one worker: send to it, and be handed what it sends. */
export interface HubEndpoint {
  send(message: HubToWorker): void;
  onMessage(handler: (message: WorkerToHub) => void): void;
}

export interface HubOptions {
  getDb: () => Database;
}

/** A question to a worker that has not been answered for this long fails (runs and undos can take hours). */
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * A run or undo that was asked of a worker which then dropped off the network keeps waiting this long
 * for the worker to come back and report (it keeps working offline, and delivers its answer from its outbox).
 */
export const OFFLINE_COMMAND_GRACE_MS = 10 * 60 * 1000;

interface WorkerLink {
  endpoint: HubEndpoint;
  /** The worker said hello; schedules are only sent after that. */
  introduced: boolean;
  lastSentVersion: number | null;
  /** The run settings last sent, as JSON: a change to them is sent as a new schedule message too. */
  lastSentSettings: string | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  jobId: number | null;
  workerId: string;
  /** Set while the worker is offline and this (untimed) command waits for it. */
  graceTimer?: NodeJS.Timeout | null;
}

/**
 * The hub: owns the database. It keeps the worker registry, hands each worker its schedule,
 * forwards commands (run, cancel, preview, undo, folder lookups) to the right worker by request
 * id, and turns the workers' reports into database rows (run history above all).
 *
 * The window, the phone page and the MCP tools (mcp/tools.ts) all reach a worker through here.
 * One exception is kept direct on purpose: the MCP tools' draft checks (checkMapping) and their
 * recursive list_folder read this machine's own folders in-process, because routing them would
 * mean new command shapes for no gain until a second worker exists.
 */
export class Hub {
  private links = new Map<string, WorkerLink>();
  private pending = new Map<string, Pending>();
  private activeRuns = new Map<number, RunProgressEvent>();
  private progressListener: ((event: RunProgressEvent) => void) | null = null;

  constructor(private opts: HubOptions) {}

  private get db(): Database {
    return this.opts.getDb();
  }

  /** Registers a worker's endpoint. The worker is sent its schedule when it says hello. */
  attachWorker(workerId: string, endpoint: HubEndpoint): void {
    this.links.set(workerId, { endpoint, introduced: false, lastSentVersion: null, lastSentSettings: null });
    // Anything that was waiting for this worker while it was away is waiting no longer.
    for (const entry of this.pending.values()) {
      if (entry.workerId === workerId && entry.graceTimer) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = null;
      }
    }
    endpoint.onMessage((message) => this.handleReport(workerId, message));
  }

  /**
   * The worker's connection is gone (only if `endpoint` is still the current one: a worker that already
   * reconnected is not detached by its old connection closing late). The worker is shown offline; what it
   * was running is no longer shown as running here; commands waiting on it fail, except runs and undos,
   * which wait a while for the worker to come back and report.
   */
  detachWorker(workerId: string, endpoint?: HubEndpoint): void {
    const link = this.links.get(workerId);
    if (!link || (endpoint && link.endpoint !== endpoint)) return;
    this.links.delete(workerId);
    for (const [jobId, event] of [...this.activeRuns]) {
      if (ownerOf(this.db, 'jobs', jobId) !== workerId) continue;
      this.activeRuns.delete(jobId);
      this.progressListener?.({ ...event, phase: 'finished' });
    }
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.workerId !== workerId) continue;
      if (entry.timer) {
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(new Error('The computer went offline before it answered.'));
      } else if (!entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          this.pending.delete(requestId);
          entry.reject(new Error('The computer went offline and did not report back. Check History: the run may have finished.'));
        }, OFFLINE_COMMAND_GRACE_MS);
        entry.graceTimer.unref?.();
      }
    }
  }

  /** True while the worker has a live connection to this hub. */
  isConnected(workerId: string): boolean {
    return this.links.get(workerId)?.introduced === true;
  }

  /**
   * One report from a worker that came over a connection of its own (the network transport). The
   * reports a worker holds in its outbox are accepted whether or not the worker is connected right
   * now: they are idempotent, and refusing them would only make the worker send them again.
   */
  receive(workerId: string, message: WorkerToHub): void {
    if (isDurableReport(message) || this.links.has(workerId)) this.handleReport(workerId, message);
  }

  /** Where progress for every run, manual or scheduled, goes (the main process forwards it to the windows and phones). */
  setProgressListener(listener: ((event: RunProgressEvent) => void) | null): void {
    this.progressListener = listener;
  }

  /** Ids of the workers that are attached right now. */
  connectedWorkerIds(): string[] {
    return [...this.links.keys()];
  }

  /** Every computer this hub knows, with whether it is online (connected and heard from within WORKER_OFFLINE_AFTER_MS). */
  listWorkerInfo(nowMs: number = Date.now()): WorkerInfo[] {
    const db = this.db;
    const counts = (table: 'mappings' | 'jobs'): Map<string, number> =>
      new Map(
        queryAll(db, `SELECT worker_id, COUNT(*) AS c FROM ${table} GROUP BY worker_id`).map((row) => [
          String(row.worker_id),
          Number(row.c),
        ])
      );
    const mappingCounts = counts('mappings');
    const jobCounts = counts('jobs');
    return listWorkers(db).map((worker) => ({
      id: worker.id,
      name: worker.name,
      kind: worker.kind,
      online: isWorkerOnline(worker, this.isConnected(worker.id), nowMs, WORKER_OFFLINE_AFTER_MS),
      lastSeenAt: worker.lastSeenAt,
      appVersion: worker.appVersion,
      paired: worker.kind === 'local' || worker.hasToken,
      mappingCount: mappingCounts.get(worker.id) ?? 0,
      jobCount: jobCounts.get(worker.id) ?? 0,
    }));
  }

  /** Jobs that are queued or running right now, with their latest progress. */
  getActiveRuns(): RunProgressEvent[] {
    return [...this.activeRuns.values()];
  }

  // Schedule sync ------------------------------------------------------------

  /**
   * Sends every connected worker its schedule if the database has a newer version than the one
   * it was last sent. Cheap to call: call it after anything that may have changed a schedule.
   */
  syncSchedules(): void {
    for (const [workerId, link] of this.links) {
      if (!link.introduced) continue;
      const version = getScheduleVersion(this.db, workerId);
      if (version === link.lastSentVersion && JSON.stringify(runSettings.read(this.db)) === link.lastSentSettings) continue;
      this.sendSchedule(workerId, link);
    }
  }

  private sendSchedule(workerId: string, link: WorkerLink): void {
    const db = this.db;
    const version = getScheduleVersion(db, workerId);
    link.lastSentVersion = version;
    const settings = runSettings.read(db);
    link.lastSentSettings = JSON.stringify(settings);
    link.endpoint.send({
      type: 'schedule',
      version,
      schedule: {
        mappings: repo.listMappings(db, false, workerId),
        jobs: repo.listJobs(db, false, workerId),
      },
      runSettings: settings,
    });
  }

  // Reports from workers -------------------------------------------------------

  private handleReport(workerId: string, message: WorkerToHub): void {
    const link = this.links.get(workerId);
    if (!link && !isDurableReport(message)) return;
    const now = new Date().toISOString();
    switch (message.type) {
      case 'hello':
        if (!link) return;
        recordWorkerHello(this.db, workerId, message, now);
        link.introduced = true;
        // A worker that connects is always sent the current schedule, whatever it says it has.
        this.sendSchedule(workerId, link);
        return;
      case 'scheduleAck':
        setScheduleAcked(this.db, workerId, message.version);
        return;
      case 'commandResult':
        this.settle(message);
        touchWorker(this.db, workerId, now);
        return;
      case 'runStarted':
        // Nothing to store until the step ends; a run that dies leaves no row (as before).
        touchWorker(this.db, workerId, now);
        return;
      case 'progress':
        if (message.event.phase === 'finished') this.activeRuns.delete(message.event.jobId);
        else this.activeRuns.set(message.event.jobId, message.event);
        this.progressListener?.(message.event);
        return;
      case 'runFinished':
        this.storeRun(workerId, message);
        touchWorker(this.db, workerId, now);
        return;
      case 'jobFinished':
        if (message.completed && repo.getJob(this.db, message.jobId)) {
          repo.setJobLastRun(this.db, message.jobId, message.startedAt);
        }
        touchWorker(this.db, workerId, now);
        return;
      case 'log':
        console[message.level](`[worker ${workerId}] ${message.message}`);
        return;
      case 'heartbeat':
        touchWorker(this.db, workerId, now);
        return;
    }
  }

  /** Writes one finished step to run history, once: a report delivered twice is ignored. */
  private storeRun(workerId: string, message: RunFinishedMessage): void {
    const db = this.db;
    // A mapping or job deleted while the step ran keeps its history row, with no link (as the
    // old code did through ON DELETE SET NULL).
    const mappingId = message.mappingId != null && repo.getMapping(db, message.mappingId) ? message.mappingId : null;
    const jobId = message.jobId != null && repo.getJob(db, message.jobId) ? message.jobId : null;
    const { runId, duplicate } = repo.recordRunOnce(db, {
      mappingId,
      mappingNameSnapshot: message.mappingNameSnapshot,
      triggerType: message.triggerType,
      result: message.result,
      status: message.status,
      errorMessage: message.errorMessage,
      triggeredByRunId: message.triggeredByRunUid ? repo.getRunIdByUid(db, message.triggeredByRunUid) : null,
      jobId,
      jobNameSnapshot: message.jobNameSnapshot,
      workerId,
      runUid: message.runUid,
    });
    if (duplicate || !message.undoesRunUid) return;
    const undone = repo.getRunIdByUid(db, message.undoesRunUid);
    if (undone != null) repo.markRunUndone(db, undone, runId);
  }

  // Commands ---------------------------------------------------------------

  private settle(message: Extract<WorkerToHub, { type: 'commandResult' }>): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    this.pending.delete(message.requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    if (message.ok) {
      entry.resolve(message.payload);
    } else if (message.errorCode === 'job_already_running' && entry.jobId != null) {
      entry.reject(new JobAlreadyRunningError(entry.jobId));
    } else {
      entry.reject(new Error(message.error ?? 'The worker could not do that.'));
    }
  }

  /** Sends a command to a worker and waits for its answer. The send itself happens before this returns. */
  private command<T>(
    workerId: string,
    build: (requestId: string) => HubCommand,
    options: { jobId?: number; untimed?: boolean } = {}
  ): Promise<T> {
    const link = this.links.get(workerId);
    if (!link?.introduced) {
      return Promise.reject(new Error('The worker for this is not connected.'));
    }
    // A worker acts only on the schedule it holds, so it is brought up to date first. Messages
    // arrive in order, so the new schedule is always applied before the command that follows.
    this.syncSchedules();
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = options.untimed
        ? null
        : setTimeout(() => {
            this.pending.delete(requestId);
            reject(new Error('The worker did not answer in time.'));
          }, COMMAND_TIMEOUT_MS);
      timer?.unref?.();
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        jobId: options.jobId ?? null,
        workerId,
      });
      link.endpoint.send(build(requestId));
    });
  }

  private workerOfJob(jobId: number): string {
    const owner = ownerOf(this.db, 'jobs', jobId);
    if (!owner) throw new Error(`No job with id ${jobId}`);
    return owner;
  }

  runJob(jobId: number, trigger: 'manual' | 'scheduled' = 'manual'): Promise<RunResult> {
    let workerId: string;
    try {
      workerId = this.workerOfJob(jobId);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.command<RunResult>(
      workerId,
      (requestId) => ({ type: 'runNow', requestId, jobId, trigger }),
      { jobId, untimed: true }
    );
  }

  /** Runs every enabled job in turn. A job that is already running is skipped, not treated as a failure. */
  async runAllEnabled(trigger: 'manual' | 'scheduled' = 'manual'): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const job of repo.listJobs(this.db, true)) {
      try {
        results.push(await this.runJob(job.id, trigger));
      } catch (err) {
        if (err instanceof JobAlreadyRunningError) continue;
        throw err;
      }
    }
    return results;
  }

  async runAll(): Promise<RunAllSummary> {
    const results = await this.runAllEnabled('manual');
    return {
      jobCount: results.length,
      mappingCount: results.reduce((sum, r) => sum + r.fileOutcomes.length, 0),
      filesMoved: results.reduce((sum, r) => sum + r.filesMoved, 0),
      filesSkipped: results.reduce((sum, r) => sum + r.filesSkipped, 0),
      filesErrored: results.reduce((sum, r) => sum + r.filesErrored, 0),
    };
  }

  /** Asks a queued or running job to stop before its next file. Work already done is kept. */
  cancelJob(jobId: number): Promise<boolean> {
    const owner = ownerOf(this.db, 'jobs', jobId);
    if (!owner) return Promise.resolve(false);
    return this.command<boolean>(owner, (requestId) => ({ type: 'cancel', requestId, jobId }));
  }

  async previewMapping(config: MappingConfig, workerId?: string): Promise<StepPreview> {
    const steps = await this.command<StepPreview[]>(workerId ?? getLocalWorkerId(this.db), (requestId) => ({
      type: 'preview',
      requestId,
      configs: [config],
    }));
    return steps[0];
  }

  /**
   * Previews every enabled step against the folders as they are right now. Steps after the first
   * are shown the same way, so a step that consumes the output of an earlier step will look
   * emptier here than it will on a real run.
   */
  async previewJob(jobId: number): Promise<JobPreview> {
    const job = repo.getJob(this.db, jobId);
    if (!job) throw new Error(`No job with id ${jobId}`);
    const configs = job.steps.filter((step) => step.enabled).map(repo.toMappingConfig);
    const steps = await this.command<StepPreview[]>(job.workerId, (requestId) => ({
      type: 'preview',
      requestId,
      configs,
    }));
    return { jobId: job.id, jobName: job.name, steps };
  }

  async undo(runId: number): Promise<RunResult> {
    const db = this.db;
    const original = repo.getRun(db, runId);
    if (!original) throw new Error(`No run with id ${runId}`);
    const fileOutcomes = repo.getRunDetail(db, runId);
    return this.command<RunResult>(
      original.workerId,
      (requestId) => ({
        type: 'undo',
        requestId,
        originalRunUid: original.runUid,
        mappingId: original.mappingId,
        mappingNameSnapshot: `Undo of “${baseMappingName(db, original)}”`,
        jobId: original.jobId,
        jobNameSnapshot: original.jobNameSnapshot,
        startedAt: original.startedAt,
        finishedAt: original.finishedAt,
        originalWasUndo: original.triggerType === 'undo',
        fileOutcomes,
      }),
      { untimed: true }
    );
  }

  /** Lists a folder on a worker's own computer (the hub's own when no worker is named). */
  listFolder(folder: string | null | undefined, workerId?: string): Promise<unknown> {
    return this.command(workerId ?? getLocalWorkerId(this.db), (requestId) => ({
      type: 'listFolder',
      requestId,
      folder: folder ?? null,
    }));
  }

  checkFolder(folder: string, role: FolderRole, workerId?: string): Promise<unknown> {
    return this.command(workerId ?? getLocalWorkerId(this.db), (requestId) => ({ type: 'checkFolder', requestId, folder, role }));
  }
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
