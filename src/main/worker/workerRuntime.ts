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
      emit: (message) => {
        if (message.type === 'jobFinished' && message.completed) this.markLastRun(message.jobId, message.startedAt);
        this.send(message);
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

  /** Introduces the worker to the hub, which answers with the current schedule. */
  connect(): void {
    this.send({
      type: 'hello',
      workerId: this.opts.workerId,
      appVersion: this.opts.appVersion,
      protocolVersion: PROTOCOL_VERSION,
      scheduleVersion: this.scheduleVersion,
    });
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
    void this.handleCommand(message);
  }

  private applySchedule(version: number, schedule: ScheduleSnapshot): void {
    this.schedule = schedule;
    this.scheduleVersion = version;
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
        for (const config of command.configs) steps.push(await previewMapping(config, { unzipLimits }));
        return steps;
      }
      case 'undo':
        return this.executor.undo(command);
      case 'listFolder':
        return listFolder(command.folder);
      case 'checkFolder':
        return checkFolder(command.folder, command.role);
    }
  }
}
