import type { JobRecord, RunResult } from '../../shared/types';
import {
  HEARTBEAT_INTERVAL_MS,
  HubCommand,
  HubToWorker,
  PROTOCOL_VERSION,
  ScheduleSnapshot,
  WorkerToHub,
} from '../../shared/workerProtocol';
import { previewMapping } from '../services/previewService';
import { checkFolder } from '../folderCheck';
import { listFolder } from '../folderBrowse';
import { SchedulerService } from '../scheduler/scheduler';
import { WatcherService } from '../scheduler/watcher';
import type { RunSettings } from '../settings/appSettings';
import type { JobSource } from './jobSource';
import { JobAlreadyRunningError, RunExecutor } from './runExecutor';
import type { AllowedFolders } from './allowedFolders';
import { jobFinishedAckId } from '../../shared/workerProtocol';
import type { Outbox } from './outbox';

export type { JobSource } from './jobSource';

/** The transport as the worker sees it: send to the hub, and be handed what the hub sends. */
export interface WorkerEndpoint {
  send(message: WorkerToHub): void;
  onMessage(handler: (message: HubToWorker) => void): void;
}

export interface WorkerRuntimeOptions {
  workerId: string;
  appVersion: string;
  endpoint: WorkerEndpoint;
  /** The worker side's only window onto settings: the run settings (see settings/appSettings.ts). */
  readRunSettings: () => RunSettings;
  /** Called, in this process, when a scheduled or watched run ends (the desktop shows a notification). */
  onBackgroundRunFinished?: (kind: 'scheduled' | 'watched folder', jobId: number, result: RunResult) => void;
  /** Send heartbeats (the app does; most tests do not need the timer). */
  heartbeat?: boolean;
  /** The secret a remote worker proves itself with (sent in the hello, never kept anywhere else). */
  token?: string;
  /** What kind of computer this is, for the hub's machine list. */
  platform?: string;
  /** Remote workers only: the folders this machine allows. Absent means no limit (the desktop's own worker). */
  allowedFolders?: AllowedFolders;
  /** Remote workers only: finished runs wait here until the hub has acknowledged them. */
  outbox?: Outbox;
  /** Remote workers only: the last schedule the hub sent, kept so the worker can run while the hub is away. */
  scheduleStore?: ScheduleStore;
}

/** Where a remote worker keeps its copy of the schedule between starts. */
export interface ScheduleStore {
  load(): { version: number; schedule: ScheduleSnapshot } | null;
  save(version: number, schedule: ScheduleSnapshot): void;
}

/**
 * The worker: owns the scheduler, the folder watchers and the file mover, and knows only the
 * schedule the hub sent it. It never opens the database; everything it learns arrives as a
 * message and everything it did leaves as one.
 */
export class WorkerRuntime implements JobSource {
  readonly executor: RunExecutor;
  readonly scheduler: SchedulerService;
  readonly watcher: WatcherService;
  private schedule: ScheduleSnapshot = { mappings: [], jobs: [] };
  private scheduleVersion = 0;
  private everApplied = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private opts: WorkerRuntimeOptions) {
    this.executor = new RunExecutor({
      workerId: opts.workerId,
      getJob: (jobId) => this.schedule.jobs.find((job) => job.id === jobId) ?? null,
      readRunSettings: opts.readRunSettings,
      guard: opts.allowedFolders,
      emit: (message) => {
        if (message.type === 'jobFinished' && message.completed) this.markLastRun(message.jobId, message.startedAt);
        this.report(message);
      },
    });
    this.scheduler = new SchedulerService(this, (jobId, result) => opts.onBackgroundRunFinished?.('scheduled', jobId, result));
    this.watcher = new WatcherService(this, (jobId, result) =>
      opts.onBackgroundRunFinished?.('watched folder', jobId, result)
    );
    opts.endpoint.onMessage((message) => this.handle(message));
  }

  // JobSource -------------------------------------------------------------

  listEnabledJobs(): JobRecord[] {
    return this.schedule.jobs.filter((job) => job.enabled);
  }

  runJob(jobId: number, trigger: 'manual' | 'scheduled'): Promise<RunResult> {
    return this.executor.runJob(jobId, trigger);
  }

  // Lifecycle -------------------------------------------------------------

  /**
   * Starts from the schedule saved the last time the hub sent one, so a remote worker keeps its
   * timers and watchers even when the hub is unreachable at start. Returns whether there was one.
   */
  loadStoredSchedule(): boolean {
    const stored = this.opts.scheduleStore?.load();
    if (!stored) return false;
    this.schedule = stored.schedule;
    this.scheduleVersion = stored.version;
    this.scheduler.reloadJobs();
    this.watcher.reloadJobs();
    if (!this.everApplied) {
      this.everApplied = true;
      this.scheduler.catchUp();
      this.watcher.catchUp();
    }
    return true;
  }

  /**
   * Introduces the worker to the hub, which answers with the current schedule. A remote worker calls
   * this again on every reconnect; whatever the hub has not acknowledged yet is sent again after it.
   */
  connect(): void {
    this.send({
      type: 'hello',
      workerId: this.opts.workerId,
      ...(this.opts.token ? { token: this.opts.token } : {}),
      appVersion: this.opts.appVersion,
      ...(this.opts.platform ? { platform: this.opts.platform } : {}),
      protocolVersion: PROTOCOL_VERSION,
      scheduleVersion: this.scheduleVersion,
    });
    for (const pending of this.opts.outbox?.pending() ?? []) this.send(pending);
    if (this.opts.heartbeat && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.send(this.heartbeatMessage()), HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
    }
  }

  shutdown(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.scheduler.shutdown();
    this.watcher.shutdown();
  }

  /** Timers are unreliable across sleep: rebuild the schedules and pick up anything that was missed. */
  resumeFromSleep(): void {
    this.scheduler.reloadJobs();
    this.scheduler.catchUp();
    this.watcher.catchUp();
  }

  // Messages --------------------------------------------------------------

  private send(message: WorkerToHub): void {
    this.opts.endpoint.send(message);
  }

  /** Reports something that must not be lost: it is kept on disk first when there is an outbox. */
  private report(message: WorkerToHub): void {
    if (this.opts.outbox && (message.type === 'runFinished' || message.type === 'jobFinished')) {
      this.opts.outbox.add(message.type === 'runFinished' ? message.runUid : jobFinishedAckId(message), message);
    }
    this.send(message);
  }

  private heartbeatMessage(): WorkerToHub {
    return { type: 'heartbeat', workerId: this.opts.workerId, sentAt: new Date().toISOString() };
  }

  private markLastRun(jobId: number, startedAt: string): void {
    const job = this.schedule.jobs.find((candidate) => candidate.id === jobId);
    if (job) job.lastRunAt = startedAt;
  }

  private handle(message: HubToWorker): void {
    if (message.type === 'schedule') {
      this.applySchedule(message.version, message.schedule);
      return;
    }
    if (message.type === 'ack') {
      this.opts.outbox?.remove(message.id);
      return;
    }
    void this.handleCommand(message);
  }

  private applySchedule(version: number, schedule: ScheduleSnapshot): void {
    this.schedule = schedule;
    this.scheduleVersion = version;
    try {
      this.opts.scheduleStore?.save(version, schedule);
    } catch {
      // The copy is only a convenience for when the hub is away; the live schedule is what counts.
    }
    this.scheduler.reloadJobs();
    this.watcher.reloadJobs();
    this.send({ type: 'scheduleAck', workerId: this.opts.workerId, version });
    if (!this.everApplied) {
      this.everApplied = true;
      // The app wasn't running while any schedule that fired since it last ran.
      this.scheduler.catchUp();
      this.watcher.catchUp();
    }
  }

  private async handleCommand(command: HubCommand): Promise<void> {
    const { requestId } = command;
    try {
      this.send({ type: 'commandResult', requestId, ok: true, payload: await this.execute(command) });
    } catch (err) {
      this.send({
        type: 'commandResult',
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: err instanceof JobAlreadyRunningError ? 'job_already_running' : undefined,
      });
    }
  }

  private async execute(command: HubCommand): Promise<unknown> {
    switch (command.type) {
      case 'runNow':
        return this.executor.runJob(command.jobId, command.trigger);
      case 'cancel':
        return this.executor.cancelJob(command.jobId);
      case 'preview': {
        const unzipLimits = this.opts.readRunSettings().unzipLimits;
        const steps = [];
        for (const config of command.configs) {
          const refused = await this.opts.allowedFolders?.problemWithMapping(config);
          if (refused) throw new Error(refused);
          steps.push(await previewMapping(config, { unzipLimits }));
        }
        return steps;
      }
      case 'undo':
        return this.executor.undo(command);
      case 'listFolder': {
        const guard = this.opts.allowedFolders;
        return guard ? guard.limitListing(command.folder, (p) => listFolder(p)) : listFolder(command.folder);
      }
      case 'checkFolder': {
        const refused = await this.opts.allowedFolders?.checkOrRefuse(command.folder);
        return refused ?? checkFolder(command.folder, command.role);
      }
    }
  }
}
