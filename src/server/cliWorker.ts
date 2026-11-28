import * as os from 'os';
import * as path from 'path';
import { setUserDataDir } from '../main/appPaths';
import { setStartupLogToFile, setStartupLogQuiet } from '../main/startupLog';
import { configureLinuxTrash } from '../main/engine/freedesktopTrash';
import { flushDatabase, initDatabase } from '../main/database/schema';
import { listWorkers, isWorkerOnline } from '../main/database/workers';
import {
  createPairing,
  findRemoteWorkerId,
  listPendingPairings,
  revokeWorkerToken,
} from '../main/database/workerAccess';
import { normalizeHubUrl, pairWithHub } from '../main/worker/remoteConnection';
import { startRemoteWorker } from '../main/worker/remoteWorker';
import { WorkerStateStore } from '../main/worker/workerState';
import { WORKER_OFFLINE_AFTER_MS } from '../shared/workerProtocol';
import { APP_VERSION, ConfigError, parseServerConfig } from './config';
import { prepareDataDir } from './server';
import { waitForSignal } from './signals';

/**
 * Where a remote worker keeps its identity, schedule and outbox. Its own folder, in the home of the user
 * that runs it (never the hub's data folder), unless FILESHUTTLE_WORKER_DIR says otherwise.
 */
export function workerStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.FILESHUTTLE_WORKER_DIR?.trim();
  if (set) {
    if (!path.isAbsolute(set)) throw new ConfigError(`FILESHUTTLE_WORKER_DIR must be an absolute path (got "${set}").`);
    return path.normalize(set);
  }
  return path.join(os.homedir(), '.config', 'fileshuttle-worker');
}

function prepareWorkerProcess(): WorkerStateStore {
  const dir = workerStateDir();
  setUserDataDir(dir);
  setStartupLogToFile(false);
  setStartupLogQuiet(true);
  const trash = process.env.FILESHUTTLE_SERVER_TRASH_DIR?.trim();
  if (trash) configureLinuxTrash({ homeTrashDir: trash });
  return new WorkerStateStore(dir);
}

/** `workers list | pair <name> | repair <name> | revoke <name>`: runs on the HUB, against its database. */
export async function workersCommand(args: string[]): Promise<number> {
  const action = args[0];
  const name = args.slice(1).join(' ').trim();
  const usage = (): number => {
    console.error('Usage: fileshuttle-server workers list | pair <name> | repair <name> | revoke <name>');
    return 2;
  };
  if (action === 'pair' || action === 'repair' || action === 'revoke') {
    if (!name) return usage();
  } else if (action !== 'list' || args.length > 1) {
    return usage();
  }
  const config = parseServerConfig();
  const dbPath = prepareDataDir(config);
  setStartupLogQuiet(true);
  const db = await initDatabase(dbPath);
  try {
    if (action === 'pair' || action === 'repair') {
      let pairing;
      if (action === 'repair') {
        const id = findRemoteWorkerId(db, name);
        if (!id) {
          console.error(`There is no paired computer named "${name}". (Use "workers list", or "workers pair" for a new one.)`);
          return 1;
        }
        pairing = createPairing(db, { workerId: id });
      } else {
        pairing = createPairing(db, { name });
      }
      flushDatabase(db);
      console.log(pairing.code);
      console.error(
        `Pairing code for "${pairing.name}". It works once and expires at ${pairing.expiresAt}.\n` +
          `On that computer: fileshuttle-server worker pair https://<this-hub's-tailscale-address> ${pairing.code}\n` +
          `(or Settings → Connect to a hub, in the desktop app).`
      );
      return 0;
    }
    if (action === 'revoke') {
      const id = revokeWorkerToken(db, name);
      flushDatabase(db);
      if (!id) {
        console.error(`There is no paired computer named "${name}".`);
        return 1;
      }
      console.log(
        `"${name}" is cut off: its token no longer works (a running hub drops its connection within seconds). ` +
          `Its mappings, jobs and history are kept. "workers repair" pairs it again.`
      );
      return 0;
    }
    const now = Date.now();
    for (const w of listWorkers(db)) {
      const state =
        w.kind === 'local'
          ? 'this hub'
          : !w.hasToken
            ? 'not paired (revoked)'
            : isWorkerOnline(w, true, now, WORKER_OFFLINE_AFTER_MS)
              ? 'online'
              : w.lastSeenAt
                ? `offline, last seen ${w.lastSeenAt}`
                : 'never connected';
      console.log(`${w.name}\t${w.kind}\t${state}${w.appVersion ? `\tv${w.appVersion}` : ''}`);
    }
    for (const p of listPendingPairings(db)) console.log(`${p.name}\twaiting for pairing\tcode expires ${p.expiresAt}`);
    return 0;
  } finally {
    db.close();
  }
}

/** `worker`: run as a worker. `worker pair <hub-address> <code>`, `worker status`, `worker unpair`: set it up. */
export async function workerCommand(args: string[]): Promise<number> {
  const action = args[0];
  const store = prepareWorkerProcess();

  if (action === 'pair') {
    const [, address, code] = args;
    if (!address || !code || args.length !== 3) {
      console.error('Usage: fileshuttle-server worker pair <hub address> <pairing code>');
      return 2;
    }
    const existing = store.loadIdentity();
    if (existing) {
      console.error(`This computer is already paired as "${existing.name}". Run "fileshuttle-server worker unpair" first to pair it again.`);
      return 1;
    }
    const paired = await pairWithHub(address, code);
    store.saveIdentity(paired);
    console.log(`Paired as "${paired.name}". Start it with: fileshuttle-server worker`);
    return 0;
  }

  if (action === 'status') {
    const identity = store.loadIdentity();
    if (!identity) {
      console.log('Not paired with a hub.');
      return 0;
    }
    console.log(`Paired as "${identity.name}" with ${normalizeHubUrl(identity.hubUrl)} (state in ${store.dir}).`);
    return 0;
  }

  if (action === 'unpair') {
    if (!store.loadIdentity()) {
      console.log('Not paired with a hub.');
      return 0;
    }
    store.clear();
    console.log('Forgotten. (Revoke it on the hub too: "fileshuttle-server workers revoke <name>".)');
    return 0;
  }

  if (action !== undefined) {
    console.error('Usage: fileshuttle-server worker [pair <hub address> <code> | status | unpair]');
    return 2;
  }

  const identity = store.loadIdentity();
  if (!identity) {
    console.error('This computer is not paired with a hub. Get a code on the hub ("fileshuttle-server workers pair <name>"), then:\n  fileshuttle-server worker pair <hub address> <code>');
    return 1;
  }
  let lastState = '';
  let revoked: () => void = () => undefined;
  const wasRevoked = new Promise<'revoked'>((resolve) => (revoked = () => resolve('revoked')));
  const running = startRemoteWorker({
    onRevoked: () => revoked(),
    store,
    identity,
    appVersion: APP_VERSION,
    log: (message) => console.log(message),
    onBackgroundRunFinished: (kind, jobId, result) =>
      console.log(
        `${kind} run finished: job ${jobId}, moved ${result.filesMoved}, copied ${result.filesCopied}, deleted ${result.filesDeleted}, errors ${result.filesErrored}`
      ),
    onStatus: (status) => {
      if (status.state === lastState) return;
      lastState = status.state;
      console.log(`hub connection: ${status.state}${status.lastError ? ` (${status.lastError})` : ''}${status.queued ? `, ${status.queued} report(s) queued` : ''}`);
    },
  });
  console.log(`FileShuttle worker ${APP_VERSION} for "${identity.name}", connecting to ${identity.hubUrl} (state in ${store.dir}).`);
  const ended = await Promise.race([waitForSignal(async () => running.stop()).then(() => 'signal' as const), wasRevoked]);
  if (ended === 'revoked') {
    running.stop();
    console.error('The hub revoked this computer. Get a new code on the hub ("workers repair <name>") and run "worker unpair", then "worker pair".');
    return 3;
  }
  return 0;
}
