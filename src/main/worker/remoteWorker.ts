import type { RunResult } from '../../shared/types';
import { DEFAULT_UNZIP_LIMITS_SETTING } from '../../shared/types';
import type { WorkerRunSettings } from '../../shared/workerProtocol';
import { Outbox } from './outbox';
import { ConnectionStatus, RemoteConnection, RemoteConnectionOptions } from './remoteConnection';
import type { WorkerIdentity, WorkerStateStore } from './workerState';
import { WorkerRuntime } from './workerRuntime';

/** What a run uses until the hub has said otherwise (the same defaults a fresh hub has). */
export function defaultRunSettings(): WorkerRunSettings {
  return {
    overwriteBackup: true,
    unzipLimits: {
      maxEntries: DEFAULT_UNZIP_LIMITS_SETTING.maxEntries,
      maxTotalBytes: Math.floor(DEFAULT_UNZIP_LIMITS_SETTING.maxTotalGB * 1024 ** 3),
    },
  };
}

export interface RemoteWorkerOptions {
  store: WorkerStateStore;
  identity: WorkerIdentity;
  appVersion: string;
  log?: (message: string) => void;
  /** Called, in this process, when a scheduled or watched run ends (the desktop shows a notification). */
  onBackgroundRunFinished?: (kind: 'scheduled' | 'watched folder', jobId: number, result: RunResult) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** The hub revoked this computer's token (after the schedule was dropped and the worker stopped). */
  onRevoked?: () => void;
  /** Overrides for tests: the fetch, the backoff and so on. */
  connection?: Partial<Pick<RemoteConnectionOptions, 'fetchImpl' | 'minBackoffMs' | 'maxBackoffMs' | 'stallMs' | 'batchMs'>>;
  heartbeat?: boolean;
}

export interface RemoteWorker {
  worker: WorkerRuntime;
  connection: RemoteConnection;
  status(): ConnectionStatus;
  /** Stops the scheduler, the watchers and the connection. What is in the outbox stays for the next start. */
  stop(): void;
}

/**
 * A worker that belongs to a hub somewhere else: the same WorkerRuntime the app runs in-process, joined to
 * the hub by the network transport, keeping its token, its last schedule and its outbox in `store`.
 * Used by `fileshuttle-server worker` and by the desktop app's "connect to a hub" mode.
 */
export function startRemoteWorker(opts: RemoteWorkerOptions): RemoteWorker {
  const { store, identity } = opts;
  let runSettings = defaultRunSettings();
  const cached = store.loadSchedule();
  if (cached?.runSettings) runSettings = cached.runSettings;

  const outbox = new Outbox(store.outboxFile, {
    onDropped: (count) => opts.log?.(`The outbox was full: the ${count} oldest reports were dropped.`),
  });

  let runtime: WorkerRuntime | null = null;
  const saveSchedule = () => {
    if (!runtime) return;
    try {
      const current = runtime.currentSchedule();
      store.saveSchedule({ ...current, runSettings });
    } catch (err) {
      opts.log?.(`Could not store the schedule: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const connection = new RemoteConnection({
    ...opts.connection,
    hubUrl: identity.hubUrl,
    token: identity.token,
    outbox,
    log: opts.log,
    onStatus: opts.onStatus,
    onRevoked: () => {
      // Cut off: stop acting on a schedule the owner took away from this computer.
      runtime?.shutdown();
      store.clearSchedule();
      opts.log?.('This computer was unpaired from the hub; nothing will run until it is paired again.');
      opts.onRevoked?.();
    },
  });

  runtime = new WorkerRuntime({
    workerId: identity.workerId,
    appVersion: opts.appVersion,
    endpoint: connection,
    readRunSettings: () => runSettings,
    onBackgroundRunFinished: opts.onBackgroundRunFinished,
    heartbeat: opts.heartbeat ?? true,
    initialSchedule: cached ? { version: cached.version, schedule: cached.schedule } : undefined,
    onScheduleApplied: (_version, _schedule, settings) => {
      if (settings) runSettings = settings;
      saveSchedule();
    },
    onLastRunChanged: saveSchedule,
  });
  runtime.connect();
  connection.start();

  return {
    worker: runtime,
    connection,
    status: () => connection.status(),
    stop: () => {
      connection.stop();
      runtime?.shutdown();
    },
  };
}
