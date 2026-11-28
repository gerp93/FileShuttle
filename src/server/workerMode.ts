import * as fs from 'fs';
import * as path from 'path';
import { setUserDataDir } from '../main/appPaths';
import { configureLinuxTrash } from '../main/engine/freedesktopTrash';
import { setStartupLogToFile, logStartupStep } from '../main/startupLog';
import { DEFAULT_UNZIP_LIMITS_SETTING } from '../shared/types';
import { AllowedFolders } from '../main/worker/allowedFolders';
import { PairResult, RemoteTransport, WebSocketFactory, pairWithHub, validateHubUrl } from '../main/worker/hubClient';
import { Outbox } from '../main/worker/outbox';
import { createTokenStore, TokenStore } from '../main/worker/tokenStore';
import { WorkerConfig, WorkerConfigError, createScheduleStore, savePairing } from '../main/worker/workerConfig';
import { WorkerRuntime } from '../main/worker/workerRuntime';
import { APP_VERSION } from './config';

/** What `fileshuttle-server worker pair` does: validates the address, trades the code, saves the id and token. */
export async function pairWorker(
  config: WorkerConfig,
  opts: { hubUrl: string; code: string; name?: string },
  deps: { tokenStore?: TokenStore; fetchImpl?: typeof fetch } = {}
): Promise<PairResult> {
  // Refuses a bad address before anything is sent.
  const hubUrl = validateHubUrl(opts.hubUrl);
  const result = await pairWithHub({
    hubUrl,
    code: opts.code,
    name: opts.name?.trim() || config.name,
    platform: process.platform,
    fetchImpl: deps.fetchImpl,
  });
  const tokenStore = deps.tokenStore ?? createTokenStore(config.dataDir);
  await tokenStore.save(result.token);
  savePairing(config.dataDir, { hubUrl, workerId: result.workerId, name: result.name });
  return result;
}

export interface RunningWorker {
  runtime: WorkerRuntime;
  transport: RemoteTransport;
  allowedFolders: AllowedFolders;
  stop(): void;
}

/** Runs this machine as a worker for the hub it was paired with. Resolves once started (it keeps running until stop). */
export async function startWorker(
  config: WorkerConfig,
  log: (message: string) => void = (m) => console.log(m),
  deps: { tokenStore?: TokenStore; factory?: WebSocketFactory; backoffStartMs?: number; backoffMaxMs?: number; heartbeat?: boolean } = {}
): Promise<RunningWorker> {
  if (!config.hubUrl || !config.workerId) {
    throw new WorkerConfigError('This machine is not paired yet. Run: fileshuttle-server worker pair --hub <address> --code <code>');
  }
  const hubUrl = validateHubUrl(config.hubUrl);
  const token = await (deps.tokenStore ?? createTokenStore(config.dataDir)).load();
  if (!token) {
    throw new WorkerConfigError('No saved token was found for this machine. Pair it again: fileshuttle-server worker pair --hub <address> --code <code>');
  }

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  setUserDataDir(config.dataDir);
  setStartupLogToFile(false);
  configureLinuxTrash({ homeTrashDir: path.join(config.dataDir, 'Trash') });

  const allowedFolders = new AllowedFolders(config.allowedFolders);
  if (allowedFolders.isEmpty) {
    log('No allowed folders are set, so this machine refuses every folder. Set FILESHUTTLE_WORKER_ALLOWED_FOLDERS or "allowedFolders" in worker.json.');
  } else {
    log(`Allowed folders: ${allowedFolders.list().join(', ')}`);
  }

  const transport = new RemoteTransport({
    hubUrl,
    log,
    factory: deps.factory,
    backoffStartMs: deps.backoffStartMs,
    backoffMaxMs: deps.backoffMaxMs,
    onOpen: () => runtime.connect(),
  });
  const runtime = new WorkerRuntime({
    workerId: config.workerId,
    appVersion: APP_VERSION,
    token,
    platform: process.platform,
    endpoint: transport,
    // A remote worker has no database, so it runs with the defaults (backup of overwritten files on).
    readRunSettings: () => ({
      overwriteBackup: true,
      unzipLimits: {
        maxEntries: DEFAULT_UNZIP_LIMITS_SETTING.maxEntries,
        maxTotalBytes: Math.floor(DEFAULT_UNZIP_LIMITS_SETTING.maxTotalGB * 1024 ** 3),
      },
    }),
    allowedFolders,
    outbox: new Outbox(path.join(config.dataDir, 'outbox')),
    scheduleStore: createScheduleStore(config.dataDir),
    heartbeat: deps.heartbeat ?? true,
    onBackgroundRunFinished: (kind, jobId, result) =>
      logStartupStep(
        `${kind} run finished: job ${jobId}, moved ${result.filesMoved}, copied ${result.filesCopied}, deleted ${result.filesDeleted}, errors ${result.filesErrored}`
      ),
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
