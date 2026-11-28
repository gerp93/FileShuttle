import type {
  FileOutcome,
  FolderRole,
  JobRecord,
  MappingConfig,
  MappingRecord,
  RunProgressEvent,
  RunResult,
  RunSummary,
} from './types';

/**
 * The messages between the hub (the app that owns the database, the window and the phone page)
 * and a worker (the thing that owns the scheduler, the folder watchers and the file mover).
 *
 * Every message is plain JSON: no functions, no Dates, no undefined, nothing that does not
 * survive `JSON.parse(JSON.stringify(x))`. Today both sides live in one process and talk over an
 * in-process transport (main/worker/inProcess.ts) that still does that round trip, so a later
 * network transport cannot be surprised by what is sent.
 *
 * Direction is part of the type name: WorkerToHub / HubToWorker.
 */

/** Bumped when a message changes in a way an older side cannot read. */
export const PROTOCOL_VERSION = 1;

/** A worker sends a heartbeat this often. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A worker the hub has heard nothing from for this long is shown as offline (three missed beats). */
export const WORKER_OFFLINE_AFTER_MS = 90_000;

/** The settings that change how a run executes (plain data; the hub's values apply to every worker). */
export interface WorkerRunSettings {
  /** Send a file replaced by an "overwrite" mapping to the Recycle Bin first. */
  overwriteBackup: boolean;
  unzipLimits: { maxEntries: number; maxTotalBytes: number };
}

/** What a worker needs to know to do its job: its mappings and jobs, steps and filters included. */
export interface ScheduleSnapshot {
  mappings: MappingRecord[];
  jobs: JobRecord[];
}

// ---------------------------------------------------------------- worker -> hub

/**
 * First message after connecting. Over the network the worker's token travels in the HTTP
 * Authorization header, never in a message, so this field stays unused.
 */
export interface HelloMessage {
  type: 'hello';
  workerId: string;
  token?: string;
  appVersion: string;
  protocolVersion: number;
  /** The newest schedule version the worker has applied (0 = none yet). */
  scheduleVersion: number;
}

/** "I applied schedule version N." */
export interface ScheduleAckMessage {
  type: 'scheduleAck';
  workerId: string;
  version: number;
}

/** Answer to a command. `errorCode` lets the hub turn a known failure back into the right error. */
export interface CommandResultMessage {
  type: 'commandResult';
  requestId: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
  errorCode?: 'job_already_running';
}

export interface RunStartedMessage {
  type: 'runStarted';
  workerId: string;
  runUid: string;
  jobId: number;
  mappingId: number;
  startedAt: string;
}

export interface ProgressMessage {
  type: 'progress';
  workerId: string;
  event: RunProgressEvent;
}

/**
 * One step of a run has finished. The hub writes the history row and its file rows from this,
 * once: `runUid` is made by the worker, so a copy delivered twice is ignored.
 */
export interface RunFinishedMessage {
  type: 'runFinished';
  workerId: string;
  runUid: string;
  mappingId: number | null;
  mappingNameSnapshot: string;
  jobId: number | null;
  jobNameSnapshot: string | null;
  triggerType: RunSummary['triggerType'];
  status: RunSummary['status'];
  errorMessage: string | null;
  /** The earlier step of the same job run, if any. */
  triggeredByRunUid: string | null;
  /** For an undo: the run that was undone. */
  undoesRunUid: string | null;
  /** Times, counts and the per-file rows. */
  result: RunResult;
}

/** A whole job run has ended (all steps, or stopped). The hub remembers when it last ran in full. */
export interface JobFinishedMessage {
  type: 'jobFinished';
  workerId: string;
  jobId: number;
  startedAt: string;
  /** False when the run was cancelled or ran no step: it does not count for "last run". */
  completed: boolean;
}

export interface LogMessage {
  type: 'log';
  workerId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  workerId: string;
  sentAt: string;
}

export type WorkerToHub =
  | HelloMessage
  | ScheduleAckMessage
  | CommandResultMessage
  | RunStartedMessage
  | ProgressMessage
  | RunFinishedMessage
  | JobFinishedMessage
  | LogMessage
  | HeartbeatMessage;

// ---------------------------------------------------------------- hub -> worker

/** The full schedule for this worker. A newer version replaces the older one completely. */
export interface ScheduleMessage {
  type: 'schedule';
  version: number;
  schedule: ScheduleSnapshot;
  /** The hub's run settings. Absent from an older hub (the worker then keeps its own defaults). */
  runSettings?: WorkerRunSettings;
}

export interface RunNowCommand {
  type: 'runNow';
  requestId: string;
  jobId: number;
  trigger: 'manual' | 'scheduled';
}

export interface CancelCommand {
  type: 'cancel';
  requestId: string;
  jobId: number;
}

/** Dry-runs these steps, in order. The hub builds the configs, so the worker needs no schedule for it. */
export interface PreviewCommand {
  type: 'preview';
  requestId: string;
  configs: MappingConfig[];
}

/** Reverses a run from its file rows. The worker answers with a runFinished (trigger 'undo') and then the result. */
export interface UndoCommand {
  type: 'undo';
  requestId: string;
  originalRunUid: string;
  mappingId: number | null;
  /** The name shown on the undo row, already worded. */
  mappingNameSnapshot: string;
  jobId: number | null;
  jobNameSnapshot: string | null;
  startedAt: string;
  finishedAt: string;
  originalWasUndo: boolean;
  fileOutcomes: FileOutcome[];
}

export interface ListFolderCommand {
  type: 'listFolder';
  requestId: string;
  folder: string | null;
}

export interface CheckFolderCommand {
  type: 'checkFolder';
  requestId: string;
  folder: string;
  role: FolderRole;
}

export type HubCommand =
  | RunNowCommand
  | CancelCommand
  | PreviewCommand
  | UndoCommand
  | ListFolderCommand
  | CheckFolderCommand;

export type HubToWorker = ScheduleMessage | HubCommand;

export type ProtocolMessage = WorkerToHub | HubToWorker;

/** Every message type, for tests and for a future decoder. */
export const WORKER_TO_HUB_TYPES = [
  'hello',
  'scheduleAck',
  'commandResult',
  'runStarted',
  'progress',
  'runFinished',
  'jobFinished',
  'log',
  'heartbeat',
] as const;

export const HUB_TO_WORKER_TYPES = [
  'schedule',
  'runNow',
  'cancel',
  'preview',
  'undo',
  'listFolder',
  'checkFolder',
] as const;

/**
 * The reports a worker must not lose. A worker that cannot reach its hub keeps these in its outbox
 * and delivers them in order once it can; everything else is only ever sent live (a progress
 * line or a heartbeat that arrives late is worth nothing). Delivery is at-least-once, and every
 * one of these is safe to receive twice: a step is stored once per `runUid`, a command is answered
 * once per `requestId`, and a job's "last run" only moves forward.
 */
export const DURABLE_WORKER_REPORTS = ['runFinished', 'jobFinished', 'commandResult'] as const;

export function isDurableReport(message: WorkerToHub): boolean {
  return (DURABLE_WORKER_REPORTS as readonly string[]).includes(message.type);
}

/** Names of the HTTP routes a worker uses on the hub (all under /worker). */
export const WORKER_ROUTES = {
  pair: '/worker/pair',
  stream: '/worker/stream',
  report: '/worker/report',
  import: '/worker/import',
} as const;

/** The most reports one POST may carry. */
export const MAX_REPORTS_PER_POST = 200;
