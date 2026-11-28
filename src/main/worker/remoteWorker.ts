import * as path from 'path';
import { DEFAULT_UNZIP_LIMITS_SETTING } from '../../shared/types';
import { AllowedFolders } from './allowedFolders';
import { RemoteTransport, WebSocketFactory, validateHubUrl } from './hubClient';
import { Outbox } from './outbox';
import { createScheduleStore } from './workerConfig';
import type { RunSettings } from '../settings/appSettings';
import { WorkerRuntime } from './workerRuntime';

type RunSettingsReader = () => RunSettings;

export interface RemoteWorkerOptions {
  hubUrl: string;
  workerId: string;
  token: string;
  /** Where the schedule copy and the outbox are kept. */
  dataDir: string;
  allowedFolders: readonly string[];
  appVersion: string;
  platform?: string;
  log?: (message: string) => void;
  readRunSettings?: RunSettingsReader;
  onBackgroundRunFinished?: ConstructorParameters<typeof WorkerRuntime>[0]['onBackgroundRunFinished'];
  factory?: WebSocketFactory;
  backoffStartMs?: number;
  backoffMaxMs?: number;
  heartbeat?: boolean;
}

export interface RunningRemoteWorker {
  runtime: WorkerRuntime;
  transport: RemoteTransport;
  allowedFolders: AllowedFolders;
  stop(): void;
}

/** Defaults for a machine that has no database of its own (backup of overwritten files on). */
export const defaultRunSettings: RunSettingsReader = () => ({
  overwriteBackup: true,
  unzipLimits: {
    maxEntries: DEFAULT_UNZIP_LIMITS_SETTING.maxEntries,
    maxTotalBytes: Math.floor(DEFAULT_UNZIP_LIMITS_SETTING.maxTotalGB * 1024 ** 3),
  },
});

/**
 * Connects a worker runtime to a remote hub over the network. Shared by the headless server worker
 * and the desktop app's "Use a remote hub" mode. It touches no process-wide state (no user-data
 * folder, no trash setup): the caller does that if it needs to.
 */
export function startRemoteWorker(opts: RemoteWorkerOptions): RunningRemoteWorker {
  const hubUrl = validateHubUrl(opts.hubUrl);
  const log = opts.log ?? (() => undefined);
  const allowedFolders = new AllowedFolders(opts.allowedFolders);
  if (allowedFolders.isEmpty) {
    log('No allowed folders are set, so this machine refuses every folder.');
  } else {
    log(`Allowed folders: ${allowedFolders.list().join(', ')}`);
  }
  const transport = new RemoteTransport({
    hubUrl,
    log,
    factory: opts.factory,
    backoffStartMs: opts.backoffStartMs,
    backoffMaxMs: opts.backoffMaxMs,
    onOpen: () => runtime.connect(),
  });
  const runtime = new WorkerRuntime({
    workerId: opts.workerId,
    appVersion: opts.appVersion,
    token: opts.token,
    platform: opts.platform ?? process.platform,
    endpoint: transport,
    readRunSettings: opts.readRunSettings ?? defaultRunSettings,
    allowedFolders,
    outbox: new Outbox(path.join(opts.dataDir, 'outbox')),
    scheduleStore: createScheduleStore(opts.dataDir),
    heartbeat: opts.heartbeat ?? true,
    onBackgroundRunFinished: opts.onBackgroundRunFinished,
  });
  runtime.loadStoredSchedule();
  transport.start();
  let stopped = false;
  return {
    runtime,
    transport,
    allowedFolders,
    stop() {
      if (stopped) return;
      stopped = true;
      transport.stop();
      runtime.shutdown();
    },
  };
}
