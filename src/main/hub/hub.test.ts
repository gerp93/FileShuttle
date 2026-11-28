import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import { queryAll, queryOne } from '../database/dbHelpers';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { getLocalWorkerId, getWorker } from '../database/workers';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { runSettings, RUN_SETTING_KEYS, HUB_SETTING_KEYS, hubSettings } from '../settings/appSettings';
import { HubToWorker as HubToWorkerMessage, PROTOCOL_VERSION, RunFinishedMessage, WorkerToHub } from '../../shared/workerProtocol';
import { Hub, HubEndpoint } from './hub';
import { startTestSystem, TestSystem } from '../worker/testUtils';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let root: string;
let db: Database;
let system: TestSystem | null = null;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-hub-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
});
afterEach(() => {
  system?.stop();
  system = null;
  db.close();
  removeDir(root);
});

function addJob(name: string, src: string, dest: string): number {
  const mappingId = repo.createMapping(db, {
    name: `${name} step`, sourcePath: src, destPath: dest, recursive: false, conflictPolicy: 'skip', enabled: true,
    scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null,
    actionType: 'move', keepNewest: null, keepNewestPerExtension: false,
  });
  return repo.createJob(db, {
    name, enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId],
  });
}

describe('hub and worker over the in-process transport', () => {
  it('runs a job end to end and records a history row with the worker id and a run uid', async () => {
    system = await startTestSystem(db);
    const src = path.join(root, 'in');
    const dest = path.join(root, 'out');
    writeFile(path.join(src, 'a.txt'), 'A');
    writeFile(path.join(src, 'b.txt'), 'B');
    const jobId = addJob('shuttle', src, dest);

    const result = await system.hub.runJob(jobId, 'manual');

    expect(result.filesMoved).toBe(2);
    expect(listTree(dest)).toEqual(['a.txt', 'b.txt']);
    const runs = repo.listRuns(db, { jobId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workerId: getLocalWorkerId(db), triggerType: 'manual', filesMoved: 2, jobNameSnapshot: 'shuttle' });
    expect(runs[0].runUid).toMatch(UUID);
    expect(repo.getRunDetail(db, runs[0].id)).toHaveLength(2);
    expect(repo.getJob(db, jobId)!.lastRunAt).not.toBeNull();
  });

  it('introduces the worker, hands it its schedule and takes its acknowledgement by version', async () => {
    system = await startTestSystem(db);
    const workerId = system.workerId;
    expect(getWorker(db, workerId)).toMatchObject({ appVersion: '0.0.0-test', protocolVersion: PROTOCOL_VERSION });
    expect(getWorker(db, workerId)!.lastSeenAt).not.toBeNull();

    const jobId = addJob('later', path.join(root, 'in'), path.join(root, 'out'));
    const version = getWorker(db, workerId)!.scheduleVersion;
    expect(getWorker(db, workerId)!.scheduleAckedVersion).toBeLessThan(version);

    system.hub.syncSchedules();
    await system.flush();

    expect(getWorker(db, workerId)!.scheduleAckedVersion).toBe(version);
    // The worker now holds the job it was sent, without ever opening the database.
    expect(system.worker.listEnabledJobs().map((j) => j.id)).toEqual([jobId]);
    expect(system.worker.executor.isJobActive(jobId)).toBe(false);
  });

  it('keeps a worker up to date before sending it a command', async () => {
    system = await startTestSystem(db);
    const src = path.join(root, 'in');
    writeFile(path.join(src, 'x.txt'));
    const jobId = addJob('fresh', src, path.join(root, 'out'));
    // No explicit sync: the run request itself brings the worker's schedule up to date first.
    await expect(system.hub.runJob(jobId, 'manual')).resolves.toMatchObject({ filesMoved: 1 });
  });

  it('undoes a run through the worker and marks the original as undone', async () => {
    system = await startTestSystem(db);
    const src = path.join(root, 'in');
    const dest = path.join(root, 'out');
    writeFile(path.join(src, 'a.txt'), 'A');
    const jobId = addJob('undoable', src, dest);
    await system.hub.runJob(jobId, 'manual');
    const original = repo.listRuns(db, { jobId })[0];

    await system.hub.undo(original.id);

    expect(listTree(src)).toEqual(['a.txt']);
    const after = repo.getRun(db, original.id)!;
    expect(after.undoneByRunId).not.toBeNull();
    const undoRun = repo.getRun(db, after.undoneByRunId!)!;
    expect(undoRun).toMatchObject({ triggerType: 'undo', workerId: getLocalWorkerId(db), mappingNameSnapshot: 'Undo of “undoable step”' });
  });

  it('answers folder lookups and previews through the worker', async () => {
    system = await startTestSystem(db);
    const src = path.join(root, 'in');
    writeFile(path.join(src, 'p.txt'));
    expect(await system.hub.checkFolder(src, 'source')).toMatchObject({ status: 'ok' });
    expect(await system.hub.listFolder(root)).toMatchObject({ folders: [expect.objectContaining({ name: 'in' })] });
    const jobId = addJob('look', src, path.join(root, 'out'));
    const preview = await system.hub.previewJob(jobId);
    expect(preview.steps).toHaveLength(1);
    expect(preview.steps[0].totalOutcomes).toBe(1);
    expect(listTree(src)).toEqual(['p.txt']); // nothing moved
  });

  it('refuses a command when no worker is connected', async () => {
    const hub = new Hub({ getDb: () => db });
    const jobId = addJob('lonely', path.join(root, 'in'), path.join(root, 'out'));
    await expect(hub.runJob(jobId)).rejects.toThrow(/not connected/);
  });
});

describe('a report delivered twice', () => {
  it('is stored once, with its file rows inserted once', async () => {
    const hub = new Hub({ getDb: () => db });
    let report: (message: WorkerToHub) => void = () => undefined;
    const endpoint: HubEndpoint = { send: () => undefined, onMessage: (handler) => (report = handler) };
    const workerId = getLocalWorkerId(db);
    hub.attachWorker(workerId, endpoint);

    const message: RunFinishedMessage = {
      type: 'runFinished',
      workerId,
      runUid: 'dup-1',
      mappingId: null,
      mappingNameSnapshot: 'gone',
      jobId: null,
      jobNameSnapshot: null,
      triggerType: 'scheduled',
      status: 'success',
      errorMessage: null,
      triggeredByRunUid: null,
      undoesRunUid: null,
      result: repo.buildRunResult(new Date(), new Date(), [
        { sourcePath: '/a', destPath: '/b', outcome: 'moved', reason: null, sizeBytes: 1 },
      ]),
    };
    report(message);
    report(message);

    expect(queryOne(db, 'SELECT COUNT(*) AS c FROM run_history')?.c).toBe(1);
    expect(queryOne(db, 'SELECT COUNT(*) AS c FROM run_history_files')?.c).toBe(1);
    expect(queryAll(db, 'SELECT run_uid, worker_id FROM run_history')).toEqual([{ run_uid: 'dup-1', worker_id: workerId }]);
  });
});

describe('settings split', () => {
  it('keeps every key in exactly one group and the worker reads only run settings', async () => {
    const hubKeys = Object.values(HUB_SETTING_KEYS) as string[];
    const runKeys = Object.values(RUN_SETTING_KEYS) as string[];
    expect(hubKeys.filter((key) => runKeys.includes(key))).toEqual([]);
    expect(new Set([...hubKeys, ...runKeys]).size).toBe(hubKeys.length + runKeys.length);

    hubSettings.setTheme(db, 'hacker');
    runSettings.setOverwriteBackup(db, false);
    runSettings.setUnzipLimitsSetting(db, { maxEntries: 5, maxTotalGB: 2 });
    expect(runSettings.read(db)).toEqual({
      overwriteBackup: false,
      unzipLimits: { maxEntries: 5, maxTotalBytes: 2 * 1024 ** 3 },
    });
    expect(hubSettings.getTheme(db)).toBe('hacker');
    // The run settings are plain data, so they can cross the protocol.
    expect(JSON.parse(JSON.stringify(runSettings.read(db)))).toEqual(runSettings.read(db));
  });
});

describe('a worker whose connection drops', () => {
  function manualWorker(workerId: string) {
    const hub = new Hub({ getDb: () => db });
    const sent: HubToWorkerMessage[] = [];
    let report: (message: WorkerToHub) => void = () => undefined;
    const endpoint: HubEndpoint = { send: (m) => sent.push(m), onMessage: (h) => (report = h) };
    hub.attachWorker(workerId, endpoint);
    const hello = (): void =>
      report({ type: 'hello', workerId, appVersion: '1', protocolVersion: PROTOCOL_VERSION, scheduleVersion: 0 });
    return { hub, sent, endpoint, report: (m: WorkerToHub) => report(m), hello };
  }

  it('fails a question that is waiting for it, at once', async () => {
    const workerId = getLocalWorkerId(db);
    const { hub, endpoint, hello } = manualWorker(workerId);
    hello();
    const answer = hub.checkFolder(root, 'source', workerId);
    hub.detachWorker(workerId, endpoint);
    await expect(answer).rejects.toThrow(/went offline/);
    expect(hub.isConnected(workerId)).toBe(false);
  });

  it('keeps a run waiting for the worker to come back and report, and then settles it', async () => {
    const workerId = getLocalWorkerId(db);
    const jobId = addJob('long', path.join(root, 'in'), path.join(root, 'out'));
    const first = manualWorker(workerId);
    first.hello();
    const run = first.hub.runJob(jobId, 'manual');
    const command = first.sent.find((m) => m.type === 'runNow') as { requestId: string };
    first.hub.detachWorker(workerId, first.endpoint);

    // the same hub, a new connection: the worker reconnects and delivers its answer from its outbox
    const endpoint: HubEndpoint = { send: () => undefined, onMessage: () => undefined };
    first.hub.attachWorker(workerId, endpoint);
    const result = repo.buildRunResult(new Date(), new Date(), []);
    first.hub.receive(workerId, { type: 'commandResult', requestId: command.requestId, ok: true, payload: result });
    await expect(run).resolves.toMatchObject({ filesMoved: 0 });
  });

  it('takes durable reports with no connection, but nothing else', () => {
    const workerId = getLocalWorkerId(db);
    const hub = new Hub({ getDb: () => db });
    hub.receive(workerId, { type: 'heartbeat', workerId, sentAt: 'x' });
    expect(getWorker(db, workerId)!.lastSeenAt).toBeNull();
    const jobId = addJob('held', path.join(root, 'in'), path.join(root, 'out'));
    hub.receive(workerId, { type: 'jobFinished', workerId, jobId, startedAt: '2026-01-02T00:00:00.000Z', completed: true });
    expect(repo.getJob(db, jobId)!.lastRunAt).toBe('2026-01-02T00:00:00.000Z');
    // an older report, delivered late, never moves "last run" back
    hub.receive(workerId, { type: 'jobFinished', workerId, jobId, startedAt: '2026-01-01T00:00:00.000Z', completed: true });
    expect(repo.getJob(db, jobId)!.lastRunAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('sends the run settings with the schedule, and again when they change', () => {
    const workerId = getLocalWorkerId(db);
    const { hub, sent, hello } = manualWorker(workerId);
    hello();
    const first = sent.filter((m) => m.type === 'schedule');
    expect(first).toHaveLength(1);
    expect((first[0] as { runSettings: unknown }).runSettings).toEqual(runSettings.read(db));
    hub.syncSchedules();
    expect(sent.filter((m) => m.type === 'schedule')).toHaveLength(1); // nothing changed
    runSettings.setOverwriteBackup(db, false);
    hub.syncSchedules();
    const all = sent.filter((m) => m.type === 'schedule') as { runSettings: { overwriteBackup: boolean } }[];
    expect(all).toHaveLength(2);
    expect(all[1].runSettings.overwriteBackup).toBe(false);
  });
});
