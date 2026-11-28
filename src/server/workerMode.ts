import * as fs from 'fs';
import * as path from 'path';
import { setUserDataDir } from '../main/appPaths';
import { configureLinuxTrash } from '../main/engine/freedesktopTrash';
import { setStartupLogToFile, logStartupStep } from '../main/startupLog';
import { PairResult, WebSocketFactory, pairWithHub, validateHubUrl } from '../main/worker/hubClient';
import { RunningRemoteWorker, startRemoteWorker } from '../main/worker/remoteWorker';
import { createTokenStore, TokenStore } from '../main/worker/tokenStore';
import { WorkerConfig, WorkerConfigError, savePairing } from '../main/worker/workerConfig';
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

export type RunningWorker = RunningRemoteWorker;

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

  const running = startRemoteWorker({
    hubUrl,
    workerId: config.workerId,
    token,
    dataDir: config.dataDir,
    allowedFolders: config.allowedFolders,
    appVersion: APP_VERSION,
    log,
    factory: deps.factory,
    backoffStartMs: deps.backoffStartMs,
    backoffMaxMs: deps.backoffMaxMs,
    heartbeat: deps.heartbeat,
    onBackgroundRunFinished: (kind, jobId, result) =>
      logStartupStep(
        `${kind} run finished: job ${jobId}, moved ${result.filesMoved}, copied ${result.filesCopied}, deleted ${result.filesDeleted}, errors ${result.filesErrored}`
      ),
  });
  if (running.allowedFolders.isEmpty) {
    log('Set FILESHUTTLE_WORKER_ALLOWED_FOLDERS or "allowedFolders" in worker.json.');
  }
  return running;
}
