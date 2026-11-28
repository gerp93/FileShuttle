import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTree, makeTempDir, removeDir, writeFile } from '../main/engine/testUtils';
import { setRemotePassword } from '../main/remote/remoteSettings';
import { setDefaultTrash } from '../main/engine/trash';
import { loadWorkerConfig } from '../main/worker/workerConfig';
import { startServer, RunningServer } from './server';
import { pairWorker, RunningWorker, startWorker } from './workerMode';
import type { ServerConfig } from './config';

vi.mock('../main/startupLog', () => ({
  logStartupStep: () => undefined,
  setStartupLogToFile: () => undefined,
  setStartupLogQuiet: () => undefined,
}));

const PASSWORD = 'a-long-test-password-1';
let root: string;
let config: ServerConfig;
let hub: RunningServer | null = null;
let worker: RunningWorker | null = null;

beforeEach(() => {
  root = makeTempDir('fileshuttle-link-');
  writeFile(path.join(root, 'web', 'index.html'), '<!doctype html><title>FileShuttle</title>');
  config = {
    dataDir: path.join(root, 'hub'),
    port: 0,
    host: '127.0.0.1',
    webDir: path.join(root, 'web'),
    trashDir: path.join(root, 'hub', 'Trash'),
  };
  setDefaultTrash(null);
});
afterEach(async () => {
  worker?.stop();
  worker = null;
  await hub?.stop();
  hub = null;
  removeDir(root);
});

const base = () => `http://127.0.0.1:${hub!.address.port}`;
const rpc = async (channel: string, args: unknown[], cookie: string) => {
  const res = await fetch(`${base()}/api/rpc/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fileshuttle': '1', origin: base(), cookie },
    body: JSON.stringify(args),
  });
  const body = (await res.json()) as { ok: boolean; result?: any; error?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.result;
};
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const linuxOnly = describe.skipIf(process.platform === 'win32');

linuxOnly('a remote worker over a real socket', () => {
  it('pairs, connects, runs a job, queues a run while stopped, and runs it after a restart', async () => {
    hub = await startServer('hub', config, () => undefined);
    await setRemotePassword(hub.db, PASSWORD);
    const login = await fetch(`${base()}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fileshuttle': '1', origin: base() },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    // Pair with a code made over the session.
    const { code } = await rpc('workers:createPairCode', [], cookie);
    const allowed = path.join(root, 'allowed');
    const forbidden = path.join(root, 'forbidden');
    fs.mkdirSync(allowed);
    const workerConfig = loadWorkerConfig({
      FILESHUTTLE_WORKER_DATA_DIR: path.join(root, 'worker'),
      FILESHUTTLE_WORKER_NAME: 'Test worker',
      FILESHUTTLE_WORKER_ALLOWED_FOLDERS: allowed,
    });
    const paired = await pairWorker(workerConfig, { hubUrl: base(), code });
    expect(paired.token).toMatch(/^fsw_/);
    expect(fs.statSync(path.join(root, 'worker', 'worker-token')).mode & 0o777).toBe(0o600);
    // The code worked once.
    await expect(pairWorker(workerConfig, { hubUrl: base(), code })).rejects.toThrow(/not valid/);

    const config2 = loadWorkerConfig({ FILESHUTTLE_WORKER_DATA_DIR: path.join(root, 'worker'), FILESHUTTLE_WORKER_ALLOWED_FOLDERS: allowed });
    const start = async () =>
      startWorker(config2, () => undefined, { backoffStartMs: 50, backoffMaxMs: 200, heartbeat: false });
    worker = await start();
    await until(async () => (await rpc('workers:list', [], cookie)).some((w: { id: string; online: boolean }) => w.id === paired.workerId && w.online), 'the worker to be online');
    const machines = await rpc('workers:list', [], cookie);
    expect(machines.find((w: { id: string }) => w.id === paired.workerId)).toMatchObject({ name: 'Test worker', kind: 'remote', platform: process.platform, online: true });

    // A job on that machine runs there.
    const src = path.join(allowed, 'in');
    const dest = path.join(allowed, 'out');
    writeFile(path.join(src, 'a.txt'), 'A');
    const mapping = (name: string, from: string, to: string) => ({
      name, sourcePath: from, destPath: to, recursive: false, conflictPolicy: 'skip', enabled: true, scheduleType: 'manual',
      scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null, actionType: 'move', keepNewest: null,
      keepNewestPerExtension: false, workerId: paired.workerId,
    });
    const job = (name: string, mappingId: number) => ({ name, enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId] });
    const mappingId = await rpc('mappings:create', [mapping('shuttle', src, dest)], cookie);
    const jobId = await rpc('jobs:create', [job('shuttle job', mappingId)], cookie);
    await until(async () => (await rpc('jobs:getStats', [jobId], cookie)) !== undefined && true, 'stats');
    await new Promise((r) => setTimeout(r, 200)); // the schedule reaches the worker
    const result = await rpc('jobs:run', [jobId], cookie);
    expect(result.filesMoved).toBe(1);
    expect(listTree(dest)).toEqual(['a.txt']);
    const history = await rpc('history:list', [{ jobId }], cookie);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ workerId: paired.workerId, filesMoved: 1 });

    // Folder browsing and checks go to that machine, and stay inside its allowed folders.
    const listing = await rpc('dialogs:listFolder', [null, paired.workerId], cookie);
    expect(listing.folders.map((f: { path: string }) => f.path)).toEqual([allowed]);
    expect((await rpc('dialogs:checkFolder', [forbidden, 'source', paired.workerId], cookie)).status).toBe('invalid');

    // A mapping outside the allowed folders is refused on that machine, not run.
    writeFile(path.join(forbidden, 'secret.txt'), 'S');
    const badMapping = await rpc('mappings:create', [mapping('bad', forbidden, path.join(allowed, 'x'))], cookie);
    const badJob = await rpc('jobs:create', [job('bad job', badMapping)], cookie);
    await new Promise((r) => setTimeout(r, 200));
    await rpc('jobs:run', [badJob], cookie);
    expect(listTree(forbidden)).toEqual(['secret.txt']);
    const badHistory = await rpc('history:list', [{ jobId: badJob }], cookie);
    expect(badHistory[0].errorMessage).toMatch(/outside the folders/);

    // Stop the worker: Run now is queued, not lost.
    worker.stop();
    worker = null;
    await until(async () => !(await rpc('workers:list', [], cookie)).find((w: { id: string }) => w.id === paired.workerId).online, 'the worker to go offline');
    writeFile(path.join(src, 'b.txt'), 'B');
    const queued = await rpc('jobs:run', [jobId], cookie);
    expect(queued.queuedFor).toBe('Test worker');
    expect((await rpc('jobs:getActive', [], cookie))[0]).toMatchObject({ jobId, phase: 'queued', waitingFor: 'Test worker' });
    expect(listTree(dest)).toEqual(['a.txt']);

    // Start it again: the queued run is sent and happens.
    worker = await start();
    await until(() => listTree(dest).includes('b.txt'), 'the queued run to happen');
    await until(async () => (await rpc('history:list', [{ jobId }], cookie)).length === 2, 'the second run in history');
    expect(await rpc('jobs:getActive', [], cookie)).toEqual([]);

    // Removing the machine cuts it off.
    await expect(rpc('workers:remove', [paired.workerId], cookie)).rejects.toThrow(/still has/);
    await rpc('jobs:delete', [jobId], cookie);
    await rpc('jobs:delete', [badJob], cookie);
    await rpc('mappings:delete', [mappingId], cookie);
    await rpc('mappings:delete', [badMapping], cookie);
    await rpc('workers:remove', [paired.workerId], cookie);
    await until(async () => !worker!.transport.connected, 'the worker to be cut off');
    expect((await rpc('workers:list', [], cookie)).map((w: { id: string }) => w.id)).not.toContain(paired.workerId);
  }, 60_000);
});
