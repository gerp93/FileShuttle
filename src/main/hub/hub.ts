import { randomUUID } from 'crypto';
import type { Database } from '../database/sqlite';
import {
  FolderRole,
  JobPreview,
  MappingConfig,
  RunAllSummary,
  RunProgressEvent,
  RunResult,
  StepPreview,
} from '../../shared/types';
import {
  HubCommand,
  HubToWorker,
  jobFinishedAckId,
  RunFinishedMessage,
  WORKER_OFFLINE_AFTER_MS,
  WorkerToHub,
} from '../../shared/workerProtocol';
import * as repo from '../database/repository';
import {
  getLocalWorkerId,
  getQueuedRun,
  getScheduleVersion,
  getWorker,
  listQueuedRuns,
  ownerOf,
  queueRun,
  recordWorkerHello,
  removeQueuedRun,
  setScheduleAcked,
  touchWorker,
} from '../database/workers';
import { JobAlreadyRunningError } from '../worker/runExecutor';

/** The transport as the hub sees one worker: send to it, and be handed what it sends. */
export interface HubEndpoint {
  send(message: HubToWorker): void;
  onMessage(handler: (message: WorkerToHub) => void): void;
  /** Ends the connection (a network endpoint does; the in-process one has nothing to end). */
  close?(reason: string): void;
}

export interface HubOptions {
  getDb: () => Database;
  /** The clock, for presence (tests move it). */
  now?: () => number;
}

/** A question to a worker that has not been answered for this long fails (runs and undos can take hours). */
const COMMAND_TIMEOUT_MS = 120_000;

interface WorkerLink {
  endpoint: HubEndpoint;
  /** The worker said hello; schedules are only sent after that. */
  introduced: boolean;
  lastSentVersion: number | null;
  /** When anything last arrived from this worker (milliseconds). Presence is judged from it. */
  lastHeard: number;
}

interface Pending {
  workerId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  jobId: number | null;
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
  private activeRuns = new Map<number, { event: RunProgressEvent; workerId: string }>();
  private progressListener: ((event: RunProgressEvent) => void) | null = null;

  constructor(private opts: HubOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get db(): Database {
    return this.opts.getDb();
  }

  /**
   * Registers a worker's endpoint. The worker is sent its schedule when it says hello. A worker that
   * connects again replaces its earlier connection (which is closed): a machine has one live link.
   */
  attachWorker(workerId: string, endpoint: HubEndpoint): void {
    const earlier = this.links.get(workerId);
    if (earlier) this.dropLink(workerId, earlier, 'This machine connected again from somewhere else.', true);
    const link: WorkerLink = { endpoint, introduced: false, lastSentVersion: null, lastHeard: this.now() };
    this.links.set(workerId, link);
    endpoint.onMessage((message) => {
      // A connection that has been replaced or dropped no longer speaks for the worker.
      if (this.links.get(workerId) !== link) return;
      this.handleReport(workerId, link, message);
    });
  }

  /** The worker's connection ended on its own (the socket closed). Ignored if it was already replaced. */
  detachWorker(workerId: string, endpoint: HubEndpoint): void {
    const link = this.links.get(workerId);
    if (link && link.endpoint === endpoint) this.dropLink(workerId, link, 'The connection ended.', false);
  }

  /** Cuts a worker off now (used when its machine is removed). */
  disconnectWorker(workerId: string, reason: string): void {
    const link = this.links.get(workerId);
    if (link) this.dropLink(workerId, link, reason, true);
  }

  private dropLink(workerId: string, link: WorkerLink, reason: string, closeEndpoint: boolean): void {
    if (this.links.get(workerId) === link) this.links.delete(workerId);
    let name = 'The machine';
    try {
      name = getWorker(this.db, workerId)?.name ?? name;
    } catch {
      // The database is already closed (the server is stopping and this socket closed after it).
    }
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.workerId !== workerId) continue;
      this.pending.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`"${name}" went offline.`));
    }
    // What it was running is no longer being reported on: clear those cards.
    for (const [jobId, active] of [...this.activeRuns]) {
      if (active.workerId !== workerId) continue;
      this.activeRuns.delete(jobId);
      this.progressListener?.({ ...active.event, phase: 'finished' });
    }
    if (closeEndpoint) {
      try {
        link.endpoint.close?.(reason);
      } catch {
        // already gone
      }
    }
  }

  /**
   * True while the worker is connected, has said hello and has been heard from lately. A local
   * (in-process) worker is online for as long as it is attached. A remote one that stays silent
   * for 90 s (three missed heartbeats) is shown offline.
   */
  isOnline(workerId: string): boolean {
    const link = this.links.get(workerId);
    if (!link?.introduced) return false;
    if (getWorker(this.db, workerId)?.kind !== 'remote') return true;
    return this.now() - link.lastHeard <= WORKER_OFFLINE_AFTER_MS;
  }

  /** Where progress for every run, manual or scheduled, goes (the main process forwards it to the windows and phones). */
  setProgressListener(listener: ((event: RunProgressEvent) => void) | null): void {
    this.progressListener = listener;
  }

  /** Ids of the workers that are attached right now. */
  connectedWorkerIds(): string[] {
    return [...this.links.keys()];
  }

  /**
   * Jobs that are queued or running right now, with their latest progress, plus the runs waiting for
   * a machine that is offline (those are kept in the database, so a restart of the hub keeps them).
   */
  getActiveRuns(): RunProgressEvent[] {
    const events = [...this.activeRuns.values()].map((entry) => entry.event);
    for (const queued of listQueuedRuns(this.db)) {
      if (this.activeRuns.has(queued.jobId)) continue;
      const event = this.waitingEvent(queued.jobId, queued.workerId);
      if (event) events.push(event);
    }
    return events;
  }

  private waitingEvent(jobId: number, workerId: string): RunProgressEvent | null {
    const job = repo.getJob(this.db, jobId);
    if (!job) return null;
    return {
      jobId,
      jobName: job.name,
      phase: 'queued',
      stepIndex: 0,
      stepCount: job.steps.filter((step) => step.enabled).length,
      stepName: '',
      scanned: 0,
      processed: 0,
      total: null,
      waitingFor: getWorker(this.db, workerId)?.name ?? 'the machine',
    };
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
      if (version === link.lastSentVersion) continue;
      this.sendSchedule(workerId, link);
    }
  }

  private sendSchedule(workerId: string, link: WorkerLink): void {
    const db = this.db;
    const version = getScheduleVersion(db, workerId);
    link.lastSentVersion = version;
    link.endpoint.send({
      type: 'schedule',
      version,
      schedule: {
        mappings: repo.listMappings(db, false, workerId),
        jobs: repo.listJobs(db, false, workerId),
      },
    });
  }

  // Reports from workers -------------------------------------------------------

  private handleReport(workerId: string, link: WorkerLink, message: WorkerToHub): void {
    const now = new Date().toISOString();
    link.lastHeard = this.now();
    if (message.type !== 'hello' && !link.introduced) return;
    switch (message.type) {
      case 'hello':
        recordWorkerHello(this.db, workerId, message, now);
        link.introduced = true;
        // A worker that connects is always sent the current schedule, whatever it says it has.
        this.sendSchedule(workerId, link);
        this.flushQueuedRuns(workerId);
        return;
      case 'scheduleAck':
        setScheduleAcked(this.db, workerId, message.version);
        return;
      case 'commandResult':
        this.settle(workerId, message);
        return;
      case 'runStarted':
        // Nothing to store until the step ends; a run that dies leaves no row (as before).
        touchWorker(this.db, workerId, now);
        return;
      case 'progress': {
        // A worker can only report on its own jobs.
        if (ownerOf(this.db, 'jobs', message.event.jobId) !== workerId) return;
        if (message.event.phase === 'finished') this.activeRuns.delete(message.event.jobId);
        else this.activeRuns.set(message.event.jobId, { event: message.event, workerId });
        this.progressListener?.(message.event);
        return;
      }
      case 'runFinished':
        this.storeRun(workerId, message);
        // Acknowledged whether it was new, a duplicate or unusable: the worker may forget it either way.
        link.endpoint.send({ type: 'ack', id: String(message.runUid) });
        return;
      case 'jobFinished':
        if (message.completed && ownerOf(this.db, 'jobs', message.jobId) === workerId) {
          repo.setJobLastRun(this.db, message.jobId, message.startedAt);
        }
        link.endpoint.send({ type: 'ack', id: jobFinishedAckId(message) });
        return;
      case 'log':
        console[message.level === 'error' || message.level === 'warn' ? message.level : 'info'](
          `[worker ${workerId}] ${String(message.message).slice(0, 2000)}`
        );
        return;
      case 'heartbeat':
        touchWorker(this.db, workerId, now);
        return;
    }
  }

  /** Writes one finished step to run history, once: a report delivered twice is ignored. */
  private storeRun(workerId: string, message: RunFinishedMessage): void {
    const db = this.db;
    if (!isUsableRunReport(message)) {
      console.warn(`[worker ${workerId}] ignored a run report it could not read`);
      return;
    }
    // A mapping or job deleted while the step ran keeps its history row, with no link (as the
    // old code did through ON DELETE SET NULL). One that belongs to another machine is not linked either.
    const mappingId =
      message.mappingId != null && ownerOf(db, 'mappings', message.mappingId) === workerId ? message.mappingId : null;
    const jobId = message.jobId != null && ownerOf(db, 'jobs', message.jobId) === workerId ? message.jobId : null;
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
    if (undone != null && repo.getRun(db, undone)?.workerId === workerId) repo.markRunUndone(db, undone, runId);
  }

  // Commands ---------------------------------------------------------------

  private settle(workerId: string, message: Extract<WorkerToHub, { type: 'commandResult' }>): void {
    const entry = this.pending.get(message.requestId);
    // An answer only counts from the worker that was asked.
    if (!entry || entry.workerId !== workerId) return;
    this.pending.delete(message.requestId);
    if (entry.timer) clearTimeout(entry.timer);
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
    if (!link?.introduced || !this.isOnline(workerId)) {
      return Promise.reject(this.notConnectedError(workerId));
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
        workerId,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        jobId: options.jobId ?? null,
      });
      link.endpoint.send(build(requestId));
    });
  }

  private notConnectedError(workerId: string): Error {
    const worker = getWorker(this.db, workerId);
    if (worker?.kind === 'remote') return new Error(`The machine "${worker.name}" is offline.`);
    return new Error('The worker for this is not connected.');
  }

  private workerOfJob(jobId: number): string {
    const owner = ownerOf(this.db, 'jobs', jobId);
    if (!owner) throw new Error(`No job with id ${jobId}`);
    return owner;
  }

  /**
   * Runs a job on its machine. A manual run for a remote machine that is offline is queued instead
   * (kept in the database, shown as waiting, cancellable) and resolves at once with `queuedFor` set;
   * it is sent when the machine reconnects.
   */
  runJob(jobId: number, trigger: 'manual' | 'scheduled' = 'manual'): Promise<RunResult> {
    let workerId: string;
    try {
      workerId = this.workerOfJob(jobId);
    } catch (err) {
      return Promise.reject(err);
    }
    if (trigger === 'manual' && !this.isOnline(workerId)) {
      const worker = getWorker(this.db, workerId);
      if (worker?.kind === 'remote' && !worker.removedAt) return Promise.resolve(this.queueOffline(jobId, workerId, worker.name));
    }
    return this.command<RunResult>(
      workerId,
      (requestId) => ({ type: 'runNow', requestId, jobId, trigger }),
      { jobId, untimed: true }
    );
  }

  private queueOffline(jobId: number, workerId: string, machineName: string): RunResult {
    queueRun(this.db, { jobId, workerId, trigger: 'manual' }, new Date().toISOString());
    const event = this.waitingEvent(jobId, workerId);
    if (event) this.progressListener?.(event);
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
      queuedFor: machineName,
    };
  }

  /** Sends the runs that were waiting for this machine, now that it is back. */
  private flushQueuedRuns(workerId: string): void {
    for (const queued of listQueuedRuns(this.db, workerId)) {
      removeQueuedRun(this.db, queued.jobId);
      this.command<RunResult>(
        workerId,
        (requestId) => ({ type: 'runNow', requestId, jobId: queued.jobId, trigger: queued.trigger }),
        { jobId: queued.jobId, untimed: true }
      ).catch((err) => {
        if (!(err instanceof JobAlreadyRunningError)) {
          console.warn(`[worker ${workerId}] a queued run of job ${queued.jobId} did not run: ${err instanceof Error ? err.message : err}`);
        }
        // Whatever showed it as waiting is cleared (a run that did start reports its own end).
        if (!this.activeRuns.has(queued.jobId)) {
          const event = this.waitingEvent(queued.jobId, workerId);
          if (event) this.progressListener?.({ ...event, phase: 'finished' });
        }
      });
    }
  }

  /** Runs every enabled job in turn. A job that is already running is skipped, not treated as a failure. */
  async runAllEnabled(trigger: 'manual' | 'scheduled' = 'manual'): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const job of repo.listJobs(this.db, true)) {
      try {
        const result = await this.runJob(job.id, trigger);
        // A run queued for an offline machine has not happened yet.
        if (!result.queuedFor) results.push(result);
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
    // A run still waiting for an offline machine is simply forgotten.
    const waiting = getQueuedRun(this.db, jobId);
    if (waiting && !this.activeRuns.has(jobId)) {
      const event = this.waitingEvent(jobId, waiting.workerId);
      removeQueuedRun(this.db, jobId);
      if (event) this.progressListener?.({ ...event, phase: 'finished' });
      return Promise.resolve(true);
    }
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

  listFolder(folder: string | null | undefined, workerId?: string): Promise<unknown> {
    return this.command(workerId ?? getLocalWorkerId(this.db), (requestId) => ({
      type: 'listFolder',
      requestId,
      folder: folder ?? null,
    }));
  }

  checkFolder(folder: string, role: FolderRole, workerId?: string): Promise<unknown> {
    return this.command(workerId ?? getLocalWorkerId(this.db), (requestId) => ({
      type: 'checkFolder',
      requestId,
      folder,
      role,
    }));
  }
}

const TRIGGERS = ['manual', 'scheduled', 'undo', 'system'];
const STATUSES = ['success', 'with_skips', 'partial', 'error'];

/** A report from another machine is checked before it is written: wrong shapes are dropped, not stored. */
function isUsableRunReport(message: RunFinishedMessage): boolean {
  const result = message.result as RunResult | undefined;
  return (
    typeof message.runUid === 'string' &&
    message.runUid.length > 0 &&
    message.runUid.length <= 100 &&
    typeof message.mappingNameSnapshot === 'string' &&
    TRIGGERS.includes(message.triggerType) &&
    STATUSES.includes(message.status) &&
    !!result &&
    typeof result === 'object' &&
    Array.isArray(result.fileOutcomes) &&
    typeof result.startedAt === 'string' &&
    typeof result.finishedAt === 'string'
  );
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
