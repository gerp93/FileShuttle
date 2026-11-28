import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { getWorker } from '../database/workers';
import { createPairing, revokeWorkerToken } from '../database/workerAccess';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { Hub } from '../hub/hub';
import { createWorkerGateway, WorkerGateway } from '../hub/workerGateway';
import { RemoteServer } from '../remote/server';
import { pairWithHub, normalizeHubUrl } from './remoteConnection';
import { RemoteWorker, startRemoteWorker } from './remoteWorker';
import { WorkerStateStore } from './workerState';
import { Outbox } from './outbox';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

const FAST = { minBackoffMs: 20, maxBackoffMs: 100, batchMs: 5 };

let root: string;
let db: Database;
let hub: Hub;
let gateway: WorkerGateway;
let server: RemoteServer | null;
let port: number;
let workers: RemoteWorker[];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function startHub(gatewayOptions: Partial<Parameters<typeof createWorkerGateway>[0]> = {}): Promise<void> {
  hub = new Hub({ getDb: () => db });
  gateway = createWorkerGateway({ getDb: () => db, hub, ...gatewayOptions });
  server = new RemoteServer({
    port,
    staticDir: root,
    handlers: {},
    allowedChannels: [],
    isPasswordSet: () => false,
    checkPassword: async () => false,
    getAllowedLogins: () => [],
    workers: gateway.handler,
  });
  await server.start();
}

async function stopHub(): Promise<void> {
  gateway.shutdown();
  await server?.stop();
  server = null;
}

const hubUrl = () => `http://127.0.0.1:${port}`;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-remote-');
  db = await initDatabase(path.join(root, 'hub', 'fileshuttle.db'));
  port = await freePort();
  workers = [];
  await startHub();
});
afterEach(async () => {
  for (const w of workers) w.stop();
  await stopHub();
  db.close();
  removeDir(root);
});

/** Pairs a fresh computer called `name` and starts a worker for it, with its own state folder. */
async function startWorker(
  name: string,
  options: { fetchImpl?: typeof fetch; heartbeat?: boolean; dir?: string } = {}
): Promise<{ worker: RemoteWorker; workerId: string; store: WorkerStateStore }> {
  const store = new WorkerStateStore(options.dir ?? path.join(root, `state-${name}`));
  let identity = store.loadIdentity();
  if (!identity) {
    const code = createPairing(db, { name }).code;
    identity = await pairWithHub(hubUrl(), code);
    store.saveIdentity(identity);
  }
  const worker = startRemoteWorker({
    store,
    identity,
    appVersion: '0.0.0-test',
    connection: { ...FAST, fetchImpl: options.fetchImpl },
    heartbeat: options.heartbeat ?? false,
  });
  workers.push(worker);
  return { worker, workerId: identity.workerId, store };
}

function addJob(workerId: string, name: string, src: string, dest: string): number {
  const mappingId = repo.createMapping(
    db,
    {
      name: `${name} step`, sourcePath: src, destPath: dest, recursive: false, conflictPolicy: 'skip', enabled: true,
      scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null,
      actionType: 'move', keepNewest: null, keepNewestPerExtension: false,
    },
    workerId
  );
  return repo.createJob(
    db,
    { name, enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId] },
    workerId
  );
}

const connected = (w: RemoteWorker) => vi.waitFor(() => expect(w.status().state).toBe('connected'));
const introduced = (workerId: string) => vi.waitFor(() => expect(hub.isConnected(workerId)).toBe(true));

describe('a worker on the other side of the network', () => {
  it('pairs, connects, is sent its schedule and runs a job on its own computer, reported to the hub once', async () => {
    const { worker, workerId } = await startWorker('KVG PC');
    await connected(worker);
    await introduced(workerId);

    const src = path.join(root, 'pc-in');
    const dest = path.join(root, 'pc-out');
    writeFile(path.join(src, 'a.txt'), 'A');
    writeFile(path.join(src, 'b.txt'), 'B');
    const jobId = addJob(workerId, 'sort', src, dest);

    const result = await hub.runJob(jobId, 'manual');

    expect(result.filesMoved).toBe(2);
    expect(listTree(dest)).toEqual(['a.txt', 'b.txt']);
    const runs = repo.listRuns(db, { jobId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workerId, triggerType: 'manual', filesMoved: 2 });
    expect(repo.getJob(db, jobId)!.lastRunAt).not.toBeNull();
    expect(getWorker(db, workerId)).toMatchObject({ kind: 'remote', appVersion: '0.0.0-test' });
    await vi.waitFor(() => expect(worker.status().queued).toBe(0)); // delivered, so removed from the outbox
  });

  it('answers folder questions about ITS computer, not the hub\'s', async () => {
    const { worker, workerId } = await startWorker('KVG PC');
    await connected(worker);
    await introduced(workerId);
    const folder = path.join(root, 'only-on-the-pc');
    writeFile(path.join(folder, 'x.txt'));
    expect(await hub.checkFolder(folder, 'source', workerId)).toMatchObject({ status: 'ok' });
    expect(await hub.listFolder(root, workerId)).toMatchObject({ folders: expect.arrayContaining([expect.objectContaining({ name: 'only-on-the-pc' })]) });
  });

  it('shows a worker as connected only while its connection is up, and stops what it was waiting for', async () => {
    const { worker, workerId } = await startWorker('KVG PC');
    await connected(worker);
    await introduced(workerId);
    worker.stop();
    await vi.waitFor(() => expect(hub.isConnected(workerId)).toBe(false));
    await expect(hub.checkFolder(root, 'source', workerId)).rejects.toThrow(/not connected/);
  });

  it('is cut off at once when its token is revoked, and does not retry', async () => {
    const { worker, workerId, store } = await startWorker('KVG PC', {});
    await connected(worker);
    await introduced(workerId);

    revokeWorkerToken(db, 'KVG PC');
    gateway.disconnect(workerId);

    await vi.waitFor(() => expect(worker.status().state).toBe('revoked'));
    expect(hub.isConnected(workerId)).toBe(false);
    expect(JSON.stringify(worker.status())).not.toContain('fsw_');
    expect(store.loadSchedule()).toBeNull(); // it stops acting on a schedule it no longer has a right to
    // it stays down: nothing reconnects it
    await new Promise((r) => setTimeout(r, 300));
    expect(worker.status().state).toBe('revoked');
    expect(hub.isConnected(workerId)).toBe(false);
  });

  it('is dropped within a sweep when it is revoked from another process (the command line)', async () => {
    await stopHub();
    await startHub({ sweepMs: 30 });
    const { worker, workerId } = await startWorker('KVG PC');
    await connected(worker);
    await introduced(workerId);
    revokeWorkerToken(db, 'KVG PC'); // no gateway.disconnect(): only the database changed
    await vi.waitFor(() => expect(hub.isConnected(workerId)).toBe(false));
    await vi.waitFor(() => expect(worker.status().state).toBe('revoked'));
  });

  it('refuses a token it does not know, and a browser that is not the worker', async () => {
    const bad = await fetch(`${hubUrl()}/worker/stream`, { headers: { Authorization: 'Bearer fsw_nope' } });
    expect(bad.status).toBe(401);
    const none = await fetch(`${hubUrl()}/worker/report`, { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    const browser = await fetch(`${hubUrl()}/worker/pair`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AAAAA-AAAAA' }),
    });
    expect(browser.status).toBe(403);
    expect((await fetch(`${hubUrl()}/worker/nothing`, { headers: { Authorization: 'Bearer x' } })).status).toBe(404);
  });

  it('refuses a worker that speaks another protocol version', async () => {
    const { worker, store } = await startWorker('KVG PC');
    await connected(worker);
    const token = store.loadIdentity()!.token;
    const res = await fetch(`${hubUrl()}/worker/stream?v=999`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(426);
  });

  it('rate-limits wrong pairing codes', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${hubUrl()}/worker/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `AAAAA-AAAA${i}` }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
    // and even the right code is refused while blocked
    const good = createPairing(db, { name: 'Late' }).code;
    await expect(pairWithHub(hubUrl(), good)).rejects.toThrow(/Too many/);
  });

  it('does not accept a report that names another worker', async () => {
    const a = await startWorker('A');
    const b = await startWorker('B');
    await connected(a.worker);
    await connected(b.worker);
    const token = a.store.loadIdentity()!.token;
    const res = await fetch(`${hubUrl()}/worker/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            type: 'runFinished', workerId: b.workerId, runUid: 'spoof-1', mappingId: null, mappingNameSnapshot: 'x', jobId: null,
            jobNameSnapshot: null, triggerType: 'scheduled', status: 'success', errorMessage: null, triggeredByRunUid: null,
            undoesRunUid: null, result: repo.buildRunResult(new Date(), new Date(), []),
          },
        ],
      }),
    });
    expect((await res.json()).accepted).toBe(1);
    expect(repo.listRuns(db)[0]).toMatchObject({ runUid: 'spoof-1', workerId: a.workerId }); // the token decides, not the message
  });

  it('drops a worker that goes silent (no heartbeat) and shows it offline; it reconnects by itself', async () => {
    await stopHub();
    await startHub({ offlineAfterMs: 250, sweepMs: 40 });
    const quiet = await startWorker('Quiet', { heartbeat: false });
    await connected(quiet.worker);
    await introduced(quiet.workerId);
    await vi.waitFor(() => expect(hub.isConnected(quiet.workerId)).toBe(false), { timeout: 3000 });
    // the worker notices the dropped stream and comes back, so it is offline only between connections
    await vi.waitFor(() => expect(quiet.worker.status().state).not.toBe('stopped'));
  });
});

describe('a worker that cannot reach its hub', () => {
  it('keeps running its schedule from disk, queues what it finished, and delivers it once the hub is back', async () => {
    const { worker, workerId, store } = await startWorker('KVG PC');
    await connected(worker);
    await introduced(workerId);
    const src = path.join(root, 'pc-in');
    const dest = path.join(root, 'pc-out');
    writeFile(path.join(src, 'a.txt'), 'A');
    const jobId = addJob(workerId, 'offline job', src, dest);
    hub.syncSchedules();
    await vi.waitFor(() => expect(worker.worker.listEnabledJobs().map((j) => j.id)).toEqual([jobId]));
    expect(store.loadSchedule()!.schedule.jobs.map((j) => j.id)).toEqual([jobId]);

    await stopHub(); // the hub goes away
    await vi.waitFor(() => expect(['offline', 'connecting']).toContain(worker.status().state));

    // the worker is on its own: a scheduled run happens and is queued
    const result = await worker.worker.runJob(jobId, 'scheduled');
    expect(result.filesMoved).toBe(1);
    expect(listTree(dest)).toEqual(['a.txt']);
    expect(repo.listRuns(db, { jobId })).toHaveLength(0);
    expect(worker.status().queued).toBeGreaterThanOrEqual(2); // runFinished + jobFinished

    await startHub(); // the hub comes back, on the same address
    await vi.waitFor(() => expect(repo.listRuns(db, { jobId })).toHaveLength(1), { timeout: 5000 });
    expect(repo.listRuns(db, { jobId })[0]).toMatchObject({ workerId, triggerType: 'scheduled', filesMoved: 1 });
    await vi.waitFor(() => expect(worker.status().queued).toBe(0));
    expect(repo.getJob(db, jobId)!.lastRunAt).not.toBeNull();
  });

  it('survives a restart of the worker with its queue and its schedule', async () => {
    const dir = path.join(root, 'state-restart');
    const first = await startWorker('KVG PC', { dir });
    await connected(first.worker);
    await introduced(first.workerId);
    const src = path.join(root, 'pc-in');
    writeFile(path.join(src, 'a.txt'), 'A');
    const jobId = addJob(first.workerId, 'restart job', src, path.join(root, 'pc-out'));
    hub.syncSchedules();
    await vi.waitFor(() => expect(first.worker.worker.listEnabledJobs()).toHaveLength(1));

    await stopHub();
    await first.worker.worker.runJob(jobId, 'scheduled');
    first.worker.stop();
    expect(new Outbox(first.store.outboxFile).size).toBeGreaterThanOrEqual(2);

    // a new process: same folder, hub still away. It already knows the schedule.
    const second = await startWorker('KVG PC', { dir });
    expect(second.worker.worker.listEnabledJobs().map((j) => j.id)).toEqual([jobId]);
    expect(second.worker.status().queued).toBeGreaterThanOrEqual(2);

    await startHub();
    await vi.waitFor(() => expect(repo.listRuns(db, { jobId })).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(() => expect(second.worker.status().queued).toBe(0));
  });

  it('delivers a report the hub already took but whose answer was lost without storing it twice', async () => {
    let loseNextAnswer = false;
    let lost = 0;
    const realFetch = fetch;
    const flaky: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (loseNextAnswer && String(input).endsWith('/worker/report')) {
        loseNextAnswer = false;
        lost++;
        throw new Error('the answer was lost on the way back');
      }
      return res;
    };
    const { worker, workerId } = await startWorker('KVG PC', { fetchImpl: flaky });
    await connected(worker);
    await introduced(workerId);
    const src = path.join(root, 'pc-in');
    writeFile(path.join(src, 'a.txt'), 'A');
    const jobId = addJob(workerId, 'twice', src, path.join(root, 'pc-out'));
    hub.syncSchedules();
    await vi.waitFor(() => expect(worker.worker.listEnabledJobs()).toHaveLength(1));

    loseNextAnswer = true;
    await worker.worker.runJob(jobId, 'scheduled');
    await vi.waitFor(() => expect(lost).toBe(1));
    // the worker retries after reconnecting; the hub gets the same report twice
    await vi.waitFor(() => expect(worker.status().queued).toBe(0), { timeout: 5000 });
    expect(repo.listRuns(db, { jobId })).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, 'pc-out'))).toEqual(['a.txt']);
  });

  it('drops one malformed report instead of blocking the whole outbox behind it', async () => {
    const { worker, workerId, store } = await startWorker('KVG PC');
    await connected(worker);
    await introduced(workerId);
    const token = store.loadIdentity()!.token;
    const res = await fetch(`${hubUrl()}/worker/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ type: 'runFinished', runUid: 'broken' }, { type: 'nonsense' }, { type: 'heartbeat', sentAt: 'x' }] }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rejected).toBeGreaterThanOrEqual(2);
    expect(body.ok).toBe(true);
  });
});

describe('hub address', () => {
  it('must be https, except to this computer', () => {
    expect(normalizeHubUrl(' https://holocron.tail1234.ts.net/ ')).toBe('https://holocron.tail1234.ts.net');
    expect(normalizeHubUrl('http://127.0.0.1:8765')).toBe('http://127.0.0.1:8765');
    expect(() => normalizeHubUrl('http://holocron:8765')).toThrow(/https/);
    expect(() => normalizeHubUrl('ftp://x')).toThrow(/https/);
    expect(() => normalizeHubUrl('not a url')).toThrow(/web address/);
  });
});
