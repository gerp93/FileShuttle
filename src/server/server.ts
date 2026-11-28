import * as fs from 'fs';
import * as path from 'path';
import { setUserDataDir } from '../main/appPaths';
import { setStartupLogToFile, logStartupStep } from '../main/startupLog';
import { configureLinuxTrash } from '../main/engine/freedesktopTrash';
import { flushDatabase, initDatabase } from '../main/database/schema';
import * as repo from '../main/database/repository';
import type { Database } from '../main/database/sqlite';
import { getLocalWorkerId } from '../main/database/workers';
import { createHandlers } from '../main/api/handlers';
import { HTTP_CHANNELS } from '../main/api/channels';
import { Hub } from '../main/hub/hub';
import { WorkerGateway } from '../main/hub/workerGateway';
import { InProcessSystem, startInProcessWorker } from '../main/worker/inProcess';
import { RemoteServer } from '../main/remote/server';
import { callLogPath, createMcpHandler } from '../main/mcp/mcpEndpoint';
import { checkRemotePassword, getRemoteSettings } from '../main/remote/remoteSettings';
import { RetentionService } from '../main/services/retention';
import { runSettings } from '../main/settings/appSettings';
import { APP_VERSION, ServerConfig } from './config';

export type ServerMode = 'hub' | 'all';

export interface RunningServer {
  db: Database;
  hub: Hub;
  /** Where the HTTP server is actually listening. */
  address: { host: string; port: number };
  /** The local worker, in `all` mode. */
  worker: InProcessSystem | null;
  /** True once a password has been set (nobody can sign in before). */
  hasPassword(): boolean;
  /** Stops the scheduler and watchers, the web server and retention, then folds the database's -wal in. */
  stop(): Promise<void>;
}

/** Points shared code at this server's data folder (no Electron). Call before opening the database. */
export function prepareDataDir(config: ServerConfig): string {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  setUserDataDir(config.dataDir);
  setStartupLogToFile(false);
  configureLinuxTrash({ homeTrashDir: config.trashDir });
  return path.join(config.dataDir, 'fileshuttle.db');
}

/**
 * Starts the hub (database, schedule sync, the password-protected web UI and API) and, in `all` mode, a local
 * worker in the same process. Nothing is reachable until a password has been set with `set-password`.
 */
export async function startServer(
  mode: ServerMode,
  config: ServerConfig,
  log: (message: string) => void = (m) => console.log(m)
): Promise<RunningServer> {
  const dbPath = prepareDataDir(config);
  const db = await initDatabase(dbPath);
  repo.migrateChainsToJobs(db);

  const retention = new RetentionService(db);
  retention.start();

  const hub = new Hub({ getDb: () => db });
  const handlers = createHandlers({
    getDb: () => db,
    hub,
    reloadJobs: () => hub.syncSchedules(),
    getVersion: () => APP_VERSION,
  });

  const mcp = createMcpHandler({
    context: { getDb: () => db, hub, afterChange: () => hub.syncSchedules() },
    getDb: () => db,
    getVersion: () => APP_VERSION,
    getLogPath: () => callLogPath(config.dataDir),
  });

  const gateway = new WorkerGateway({ getDb: () => db, hub, log: (message) => log(`workers: ${message}`) });
  const web = new RemoteServer({
    workers: { pair: gateway.pair, accept: gateway.accept },
    port: config.port,
    host: config.host,
    staticDir: config.webDir,
    handlers,
    mcp,
    allowedChannels: HTTP_CHANNELS,
    isPasswordSet: () => getRemoteSettings(db).hasPassword,
    checkPassword: (password) => checkRemotePassword(db, password),
    getAllowedLogins: () => getRemoteSettings(db).allowedLogins,
    onError: (message) => log(`remote: ${message}`),
  });
  let port: number;
  try {
    port = await web.start();
  } catch (err) {
    retention.shutdown();
    flushDatabase(db);
    db.close();
    throw err;
  }
  hub.setProgressListener((event) => web.broadcast(event));

  let worker: InProcessSystem | null = null;
  if (mode === 'all') {
    worker = startInProcessWorker(hub, {
      workerId: getLocalWorkerId(db),
      appVersion: APP_VERSION,
      readRunSettings: () => runSettings.read(db),
      onBackgroundRunFinished: (kind, jobId, result) =>
        logStartupStep(
          `${kind} run finished: job ${jobId}, moved ${result.filesMoved}, copied ${result.filesCopied}, deleted ${result.filesDeleted}, errors ${result.filesErrored}`
        ),
      heartbeat: true,
    });
  }

  let stopped = false;
  return {
    db,
    hub,
    address: { host: config.host, port },
    worker,
    hasPassword: () => getRemoteSettings(db).hasPassword,
    async stop() {
      if (stopped) return;
      stopped = true;
      worker?.stop();
      retention.shutdown();
      gateway.stop();
      await web.stop();
      flushDatabase(db);
      db.close();
    },
  };
}
