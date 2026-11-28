import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryAll } from '../database/dbHelpers';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import type { Database } from '../database/sqlite';
import { getWorker, listQueuedRuns, listWorkers } from '../database/workers';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import type { WebSocketConnection } from '../net/webSocket';
import { createHandlers } from '../api/handlers';
import { AllowedFolders } from '../worker/allowedFolders';
import { Outbox } from '../worker/outbox';
import { WorkerRuntime } from '../worker/workerRuntime';
import { PROTOCOL_VERSION, HubToWorker, WorkerToHub, RunFinishedMessage } from '../../shared/workerProtocol';
import { runSettings } from '../settings/appSettings';
import { Hub } from './hub';
import { createPairingCode } from './pairing';
import { CLOSE_BAD_HELLO, CLOSE_HELLO_TIMEOUT, CLOSE_NOT_ACCEPTED, CLOSE_PROTOCOL, CLOSE_REPLACED, WorkerGateway } from './workerGateway';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;
let clock = Date.parse('2026-06-01T12:00:00Z');
let hub: Hub;
let gateway: WorkerGateway;
let logs: string[];

beforeEach(async () => {
  root = makeTempDir('fileshuttle-remote-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  clock = Date.parse('2026-06-01T12:00:00Z');
  logs = [];
  hub = new Hub({ getDb: () => db, now: () => clock });
  gateway = new WorkerGateway({ getDb: () => db, hub, log: (m) => logs.push(m), helloTimeoutMs: 60, pingEveryMs: 100_000 });
});
afterEach(() => {
  gateway.stop();
  db.close();
  removeDir(root);
});

// ---------------------------------------------------------------- helpers

class FakeConnection implements WebSocketConnection {
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private messageHandler: ((text: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  /** What the worker side listens to. */
  toWorker: ((text: string) => void) | null = null;
  remoteAddress = '127.0.0.1';
  send(text: string): void {
    if (this.closedWith) return;
    this.sent.push(text);
    this.toWorker?.(text);
  }
  ping(): void {}
  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    this.closeHandler?.();
  }
  terminate(): void {
    this.close(1006, '');
  }
  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }
  onPong(): void {}
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  /** The worker says something. */
  say(message: unknown): void {
    this.messageHandler?.(typeof message === 'string' ? message : JSON.stringify(message));
  }
  /** The worker's side goes away. */
  drop(): void {
    this.closedWith ??= { code: 1006, reason: '' };
    this.closeHandler?.();
  }
}

function pairMachine(name = 'Garage PC'): { workerId: string; token: string } {
  const out = gateway.pair({ code: createPairingCode(db).code, name, platform: 'linux' });
  const body = out.body as { workerId: string; token: string };
  expect(out.status).toBe(200);
  return body;
}

const hello = (workerId: string, token: string, extra: Record<string, unknown> = {}) => ({
  type: 'hello', workerId, token, appVersion: '1.2.3', platform: 'linux', protocolVersion: PROTOCOL_VERSION, scheduleVersion: 0, ...extra,
});

/** Connects a scripted worker and says hello. */
function connectScripted(workerId: string, token: string, extra: Record<string, unknown> = {}): FakeConnection {
  const conn = new FakeConnection();
  gateway.accept(conn);
  conn.say(hello(workerId, token, extra));
  return conn;
}

/** Connects a real WorkerRuntime to the gateway through a fake connection. */
function connectRuntime(
  workerId: string,
  token: string,
  extra: Partial<ConstructorParameters<typeof WorkerRuntime>[0]> = {}
): { runtime: WorkerRuntime; conn: FakeConnection } {
  const conn = new FakeConnection();
  gateway.accept(conn);
  let handler: ((message: HubToWorker) => void) | null = null;
  conn.toWorker = (text) => queueMicrotask(() => handler?.(JSON.parse(text) as HubToWorker));
  const runtime = new WorkerRuntime({
    workerId,
    appVersion: '1.2.3',
    token,
    platform: 'linux',
    endpoint: {
      send: (message) => conn.say(JSON.stringify(message)),
      onMessage: (h) => {
        handler = h;
      },
    },
    readRunSettings: () => runSettings.read(db),
    ...extra,
  });
  runtime.connect();
  return { runtime, conn };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function addJob(workerId: string, name: string, src: string, dest: string): { jobId: number; mappingId: number } {
  const mappingId = repo.createMapping(db, {
    name: `${name} step`, sourcePath: src, destPath: dest, recursive: false, conflictPolicy: 'skip', enabled: true,
    scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null,
    actionType: 'move', keepNewest: null, keepNewestPerExtension: false, workerId,
  });
  const jobId = repo.createJob(db, {
    name, enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId],
  });
  return { jobId, mappingId };
}

// ---------------------------------------------------------------- pairing endpoint

describe('the pair endpoint', () => {
  it('trades a code for an id and a token, once', () => {
    const { code } = createPairingCode(db);
    const ok = gateway.pair({ code, name: 'Studio', platform: 'darwin' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, name: 'Studio', token: expect.stringMatching(/^fsw_/) });
    expect(listWorkers(db).find((w) => w.name === 'Studio')).toMatchObject({ kind: 'remote', platform: 'darwin' });
    expect(gateway.pair({ code }).status).toBe(401);
    expect(gateway.pair({}).status).toBe(400);
    expect(gateway.pair('nonsense').status).toBe(400);
  });
});

// ---------------------------------------------------------------- hello and auth

describe('the hello', () => {
  it('accepts a good token, records the machine and sends its schedule, never keeping the token', async () => {
    const { workerId, token } = pairMachine();
    const conn = connectScripted(workerId, token);
    await settle();
    expect(conn.closedWith).toBeNull();
    expect(hub.isOnline(workerId)).toBe(true);
    expect(getWorker(db, workerId)).toMatchObject({ appVersion: '1.2.3', platform: 'linux', protocolVersion: PROTOCOL_VERSION });
    expect(JSON.parse(conn.sent[0])).toMatchObject({ type: 'schedule' });
    expect(JSON.stringify(queryAll(db, 'SELECT * FROM workers'))).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
    expect(conn.sent.join('\n')).not.toContain(token);
  });

  it('closes a connection whose first message is not a hello', () => {
    const { workerId } = pairMachine();
    const conn = new FakeConnection();
    gateway.accept(conn);
    conn.say({ type: 'heartbeat', workerId, sentAt: 'x' });
    expect(conn.closedWith?.code).toBe(CLOSE_BAD_HELLO);
    const bad = new FakeConnection();
    gateway.accept(bad);
    bad.say('not json');
    expect(bad.closedWith?.code).toBe(CLOSE_BAD_HELLO);
    const noToken = new FakeConnection();
    gateway.accept(noToken);
    const { token: _drop, ...withoutToken } = hello(workerId, 'x');
    noToken.say(withoutToken);
    expect(noToken.closedWith?.code).toBe(CLOSE_BAD_HELLO);
  });

  it('closes a connection that says nothing for too long', async () => {
    const conn = new FakeConnection();
    gateway.accept(conn);
    await new Promise((r) => setTimeout(r, 120));
    expect(conn.closedWith?.code).toBe(CLOSE_HELLO_TIMEOUT);
  });

  it('refuses a wrong token, an unknown machine and a removed machine with the same plain sentence', async () => {
    const { workerId, token } = pairMachine();
    const wrong = connectScripted(workerId, `${token}x`);
    const unknown = connectScripted('no-such-machine', token);
    expect(wrong.closedWith).toMatchObject({ code: CLOSE_NOT_ACCEPTED });
    expect(unknown.closedWith).toEqual(wrong.closedWith);
    expect(wrong.closedWith!.reason).not.toContain(token);

    const handlers = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '1.2.3' });
    const live = connectScripted(workerId, token);
    await settle();
    expect(hub.isOnline(workerId)).toBe(true);
    handlers['workers:remove'](workerId);
    expect(live.closedWith).not.toBeNull();
    expect(hub.isOnline(workerId)).toBe(false);
    expect(connectScripted(workerId, token).closedWith).toMatchObject({ code: CLOSE_NOT_ACCEPTED });
  });

  it('refuses another protocol version with a plain message naming both versions', () => {
    const { workerId, token } = pairMachine();
    const conn = connectScripted(workerId, token, { protocolVersion: PROTOCOL_VERSION + 1 });
    expect(conn.closedWith?.code).toBe(CLOSE_PROTOCOL);
    expect(conn.closedWith?.reason).toContain(`protocol ${PROTOCOL_VERSION + 1}`);
    expect(conn.closedWith?.reason).toContain(`speaks ${PROTOCOL_VERSION}`);
    expect(conn.closedWith?.reason).not.toContain(token);
    const old = connectScripted(workerId, token, { protocolVersion: PROTOCOL_VERSION - 1 });
    expect(old.closedWith?.code).toBe(CLOSE_PROTOCOL);
    expect(old.closedWith?.reason).toContain('Update the worker');
  });

  it('lets a second connection replace the first', async () => {
    const { workerId, token } = pairMachine();
    const first = connectScripted(workerId, token);
    await settle();
    const second = connectScripted(workerId, token);
    await settle();
    expect(first.closedWith?.code).toBe(CLOSE_REPLACED);
    expect(second.closedWith).toBeNull();
    expect(hub.isOnline(workerId)).toBe(true);
    // The first connection's close does not take the second one offline.
    first.drop();
    expect(hub.isOnline(workerId)).toBe(true);
  });

  it('ignores a worker id inside later messages that is not the connection’s own', async () => {
    const a = pairMachine('A');
    const b = pairMachine('B');
    const conn = connectScripted(a.workerId, a.token);
    await settle();
    const before = getWorker(db, b.workerId)!.lastSeenAt;
    conn.say({ type: 'heartbeat', workerId: b.workerId, sentAt: new Date().toISOString() });
    expect(getWorker(db, b.workerId)!.lastSeenAt).toBe(before);
  });
});

// ---------------------------------------------------------------- presence

describe('presence', () => {
  it('is online while heard from, offline after 90 s of silence, online again on a heartbeat', async () => {
    const { workerId, token } = pairMachine();
    const conn = connectScripted(workerId, token);
    await settle();
    expect(hub.isOnline(workerId)).toBe(true);
    clock += 89_000;
    expect(hub.isOnline(workerId)).toBe(true);
    clock += 2_000;
    expect(hub.isOnline(workerId)).toBe(false);
    conn.say({ type: 'heartbeat', workerId, sentAt: new Date(clock).toISOString() });
    expect(hub.isOnline(workerId)).toBe(true);
    expect(getWorker(db, workerId)!.lastSeenAt).not.toBeNull();
    conn.drop();
    expect(hub.isOnline(workerId)).toBe(false);
  });
});

// ---------------------------------------------------------------- Run now for an offline machine

describe('Run now for an offline machine', () => {
  it('is queued, shown as waiting, never duplicated, and cancellable', async () => {
    const { workerId } = pairMachine('Garage PC');
    const { jobId } = addJob(workerId, 'nightly', path.join(root, 'in'), path.join(root, 'out'));

    const first = await hub.runJob(jobId, 'manual');
    expect(first.queuedFor).toBe('Garage PC');
    const second = await hub.runJob(jobId, 'manual');
    expect(second.queuedFor).toBe('Garage PC');
    expect(listQueuedRuns(db)).toHaveLength(1);
    expect(hub.getActiveRuns()).toEqual([
      expect.objectContaining({ jobId, phase: 'queued', waitingFor: 'Garage PC' }),
    ]);

    expect(await hub.cancelJob(jobId)).toBeTruthy();
    expect(listQueuedRuns(db)).toHaveLength(0);
    expect(hub.getActiveRuns()).toEqual([]);
  });

  it('survives a restart of the hub and runs when the machine reconnects', async () => {
    const { workerId, token } = pairMachine();
    const src = path.join(root, 'in');
    const dest = path.join(root, 'out');
    writeFile(path.join(src, 'a.txt'), 'A');
    const { jobId } = addJob(workerId, 'nightly', src, dest);
    expect((await hub.runJob(jobId, 'manual')).queuedFor).toBeTruthy();

    // A new hub on the same database knows about it.
    hub = new Hub({ getDb: () => db, now: () => clock });
    gateway.stop();
    gateway = new WorkerGateway({ getDb: () => db, hub, helloTimeoutMs: 1000, pingEveryMs: 100_000 });
    expect(hub.getActiveRuns()).toHaveLength(1);

    const { runtime } = connectRuntime(workerId, token);
    await new Promise((r) => setTimeout(r, 200));
    expect(listTree(dest)).toEqual(['a.txt']);
    expect(listQueuedRuns(db)).toHaveLength(0);
    expect(repo.listRuns(db, { jobId })).toHaveLength(1);
    expect(repo.listRuns(db, { jobId })[0]).toMatchObject({ workerId, triggerType: 'manual' });
    runtime.shutdown();
  });

  it('does not queue a scheduled run, and a job of a machine that is online runs at once', async () => {
    const { workerId, token } = pairMachine();
    const src = path.join(root, 'in');
    writeFile(path.join(src, 'a.txt'), 'A');
    const { jobId } = addJob(workerId, 'now', src, path.join(root, 'out'));
    await expect(hub.runJob(jobId, 'scheduled')).rejects.toThrow(/offline/);
    expect(listQueuedRuns(db)).toHaveLength(0);

    const { runtime } = connectRuntime(workerId, token);
    await settle();
    const result = await hub.runJob(jobId, 'manual');
    expect(result.filesMoved).toBe(1);
    expect(result.queuedFor).toBeUndefined();
    runtime.shutdown();
  });

  it('is dropped with its job, and a machine that still owns anything is not removed', async () => {
    const { workerId } = pairMachine();
    const { jobId, mappingId } = addJob(workerId, 'x', path.join(root, 'in'), path.join(root, 'out'));
    await hub.runJob(jobId, 'manual');
    expect(listQueuedRuns(db)).toHaveLength(1);
    const handlers = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '1' });
    expect(() => handlers['workers:remove'](workerId)).toThrow(/still has 1 mapping and 1 job/);
    repo.deleteJob(db, jobId);
    expect(listQueuedRuns(db)).toHaveLength(0);
    repo.deleteMapping(db, mappingId);
    handlers['workers:remove'](workerId);
    expect(listWorkers(db).map((w) => w.id)).not.toContain(workerId);
  });
});

// ---------------------------------------------------------------- reports, acknowledgements and the outbox

describe('reports', () => {
  function runFinished(workerId: string, jobId: number, mappingId: number, runUid: string): RunFinishedMessage {
    const now = new Date().toISOString();
    return {
      type: 'runFinished', workerId, runUid, mappingId, mappingNameSnapshot: 'm', jobId, jobNameSnapshot: 'j', triggerType: 'scheduled',
      status: 'success', errorMessage: null, triggeredByRunUid: null, undoesRunUid: null,
      result: {
        startedAt: now, finishedAt: now, fileOutcomes: [{ sourcePath: '/a', destPath: '/b', outcome: 'moved', reason: null, sizeBytes: 1 }],
        filesMoved: 1, filesCopied: 0, filesDeleted: 0, filesSkipped: 0, filesErrored: 0, filesExtracted: 0, filesZipped: 0,
      },
    };
  }

  it('stores a run once however often it is sent, and acknowledges every time', async () => {
    const { workerId, token } = pairMachine();
    const { jobId, mappingId } = addJob(workerId, 'j', '/a', '/b');
    const conn = connectScripted(workerId, token);
    await settle();
    const message = runFinished(workerId, jobId, mappingId, '11111111-1111-4111-8111-111111111111');
    conn.say(message);
    conn.say(message);
    const acks = conn.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'ack');
    expect(acks).toEqual([
      { type: 'ack', id: message.runUid },
      { type: 'ack', id: message.runUid },
    ]);
    expect(repo.listRuns(db, { jobId })).toHaveLength(1);
  });

  it('keeps a finished run in the outbox until the hub acknowledges it, then sends it again after a reconnect', async () => {
    const { workerId, token } = pairMachine();
    const src = path.join(root, 'in');
    const dest = path.join(root, 'out');
    writeFile(path.join(src, 'a.txt'), 'A');
    const { jobId } = addJob(workerId, 'offline run', src, dest);
    const outbox = new Outbox(path.join(root, 'outbox'));

    // The worker works from a schedule it has saved, with no hub connected.
    const snapshot = { mappings: repo.listMappings(db, false, workerId), jobs: repo.listJobs(db, false, workerId) };
    const sent: WorkerToHub[] = [];
    const lonely = new WorkerRuntime({
      workerId, appVersion: '1.2.3', token, endpoint: { send: (m) => sent.push(m), onMessage: () => undefined },
      readRunSettings: () => runSettings.read(db), outbox,
      scheduleStore: { load: () => ({ version: 1, schedule: snapshot }), save: () => undefined },
    });
    expect(lonely.loadStoredSchedule()).toBe(true);
    await lonely.runJob(jobId, 'scheduled');
    lonely.shutdown();
    expect(listTree(dest)).toEqual(['a.txt']);
    expect(outbox.size).toBe(2); // the run, and "job finished"
    expect(repo.listRuns(db, { jobId })).toHaveLength(0);

    // A new process finds the files and reports them once the hub is reachable.
    const reopened = new Outbox(path.join(root, 'outbox'));
    expect(reopened.size).toBe(2);
    const { runtime } = connectRuntime(workerId, token, { outbox: reopened });
    await settle();
    expect(repo.listRuns(db, { jobId })).toHaveLength(1);
    expect(repo.listRuns(db, { jobId })[0]).toMatchObject({ workerId, triggerType: 'scheduled', filesMoved: 1 });
    expect(reopened.size).toBe(0);
    expect(fs.readdirSync(path.join(root, 'outbox'))).toEqual([]);
    expect(repo.getJob(db, jobId)!.lastRunAt).not.toBeNull();

    // Reconnecting again sends nothing twice.
    runtime.connect();
    await settle();
    expect(repo.listRuns(db, { jobId })).toHaveLength(1);
    runtime.shutdown();
  });

  it('ignores a report for a job the machine does not own', async () => {
    const a = pairMachine('A');
    const b = pairMachine('B');
    const { jobId, mappingId } = addJob(b.workerId, 'b job', '/a', '/b');
    const conn = connectScripted(a.workerId, a.token);
    await settle();
    conn.say(runFinished(a.workerId, jobId, mappingId, '22222222-2222-4222-8222-222222222222'));
    const runs = repo.listRuns(db, { jobId });
    // The run is kept (it happened) but is not linked to a job or mapping of another machine.
    expect(runs.every((r) => r.workerId === a.workerId && r.jobId === null)).toBe(true);
  });
});

// ---------------------------------------------------------------- allowed folders on the worker

describe('allowed folders on a remote worker', () => {
  it('runs inside them and refuses outside, with the reason in history', async () => {
    const { workerId, token } = pairMachine();
    const allowed = path.join(root, 'allowed');
    const forbidden = path.join(root, 'forbidden');
    writeFile(path.join(allowed, 'in', 'a.txt'), 'A');
    writeFile(path.join(forbidden, 'secret.txt'), 'S');
    const good = addJob(workerId, 'good', path.join(allowed, 'in'), path.join(allowed, 'out'));
    const bad = addJob(workerId, 'bad', forbidden, path.join(allowed, 'out2'));
    const { runtime } = connectRuntime(workerId, token, { allowedFolders: new AllowedFolders([allowed]) });
    await settle();

    expect((await hub.runJob(good.jobId, 'manual')).filesMoved).toBe(1);
    await hub.runJob(bad.jobId, 'manual');
    expect(listTree(forbidden)).toEqual(['secret.txt']);
    const row = repo.listRuns(db, { jobId: bad.jobId })[0];
    expect(row.status).toBe('error');
    expect(row.errorMessage).toMatch(/outside the folders this machine allows/);

    await expect(hub.checkFolder(forbidden, 'source', workerId)).resolves.toMatchObject({ status: 'invalid' });
    await expect(hub.checkFolder(path.join(allowed, 'in'), 'source', workerId)).resolves.toMatchObject({ status: expect.not.stringMatching(/invalid/) });
    const listing = (await hub.listFolder(null, workerId)) as { folders: Array<{ path: string }> };
    expect(listing.folders.map((f) => f.path)).toEqual([allowed]);
    await expect(hub.listFolder(forbidden, workerId)).resolves.toMatchObject({ error: expect.stringMatching(/outside/) });
    runtime.shutdown();
  });

  it('with no allowed folders refuses everything', async () => {
    const { workerId, token } = pairMachine();
    const src = path.join(root, 'in');
    writeFile(path.join(src, 'a.txt'), 'A');
    const { jobId } = addJob(workerId, 'x', src, path.join(root, 'out'));
    const { runtime } = connectRuntime(workerId, token, { allowedFolders: new AllowedFolders([]) });
    await settle();
    await hub.runJob(jobId, 'manual');
    expect(listTree(src)).toEqual(['a.txt']);
    expect(repo.listRuns(db, { jobId })[0].errorMessage).toMatch(/no allowed folders/);
    runtime.shutdown();
  });
});

// ---------------------------------------------------------------- one machine per job

describe('machines and jobs', () => {
  it('refuses a job whose mappings are on different machines, and a mapping on a removed or unknown machine', () => {
    const a = pairMachine('A');
    const b = pairMachine('B');
    const one = addJob(a.workerId, 'one', '/a', '/b');
    const two = addJob(b.workerId, 'two', '/c', '/d');
    expect(() =>
      repo.createJob(db, { name: 'mixed', enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [one.mappingId, two.mappingId] })
    ).toThrow(/one machine/);
    expect(() => addJob('no-such-worker', 'x', '/a', '/b')).toThrow();
    const handlers = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '1' });
    repo.deleteJob(db, two.jobId);
    repo.deleteMapping(db, two.mappingId);
    handlers['workers:remove'](b.workerId);
    expect(() => addJob(b.workerId, 'again', '/a', '/b')).toThrow();
  });

  it('lists machines with a version notice only for an older worker', async () => {
    const { workerId, token } = pairMachine();
    connectScripted(workerId, token, { appVersion: '1.0.0' });
    await settle();
    const handlers = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '1.2.0' });
    const list = handlers['workers:list']() as Array<{ id: string; kind: string; online: boolean; versionNotice: string | null }>;
    expect(list.find((w) => w.id === workerId)).toMatchObject({ online: true, versionNotice: expect.stringContaining('1.0.0') });
    expect(list.find((w) => w.kind === 'local')!.versionNotice).toBeNull();
    const same = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '1.0.0' });
    expect((same['workers:list']() as Array<{ id: string; versionNotice: string | null }>).find((w) => w.id === workerId)!.versionNotice).toBeNull();
    const dev = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '0.0.0-dev' });
    expect((dev['workers:list']() as Array<{ id: string; versionNotice: string | null }>).find((w) => w.id === workerId)!.versionNotice).toBeNull();
  });

  it('refuses to remove this computer’s own worker', () => {
    const handlers = createHandlers({ getDb: () => db, hub, reloadJobs: () => undefined, getVersion: () => '1' });
    const local = listWorkers(db).find((w) => w.kind === 'local')!;
    expect(() => handlers['workers:remove'](local.id)).toThrow(/cannot be removed/);
  });
});
