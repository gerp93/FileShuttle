import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../main/database/repository';
import { initDatabase } from '../main/database/schema';
import type { Database } from '../main/database/sqlite';
import { listTree, makeTempDir, removeDir, writeFile } from '../main/engine/testUtils';
import { setDefaultTrash } from '../main/engine/trash';
import { setRemotePassword } from '../main/remote/remoteSettings';
import { RemoteHubError, RemoteHubManager } from '../main/remoteHub/remoteHubManager';
import { buildSetupPayload } from '../main/remoteHub/setupExport';
import { startServer, RunningServer } from './server';
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
let localDb: Database | null = null;
let manager: RemoteHubManager | null = null;
const events: string[] = [];

beforeEach(() => {
  root = makeTempDir('fileshuttle-desktop-remote-');
  writeFile(path.join(root, 'web', 'index.html'), '<!doctype html><title>FileShuttle</title>');
  config = { dataDir: path.join(root, 'hub'), port: 0, host: '127.0.0.1', webDir: path.join(root, 'web'), trashDir: path.join(root, 'hub', 'Trash') };
  setDefaultTrash(null);
  events.length = 0;
});
afterEach(async () => {
  manager?.shutdown();
  manager = null;
  await hub?.stop();
  hub = null;
  localDb?.close();
  localDb = null;
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

linuxOnly('the desktop app in remote-hub mode (main-process pieces, no window)', () => {
  it('pairs, sends its setup once, runs a hub job on this computer, and turns off cleanly', async () => {
    // The remote hub.
    hub = await startServer('hub', config, () => undefined);
    await setRemotePassword(hub.db, PASSWORD);
    const login = await fetch(`${base()}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fileshuttle': '1', origin: base() },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    // The desktop's own database, with a job and two mappings in it.
    const allowed = path.join(root, 'allowed');
    const src = path.join(allowed, 'in');
    const dest = path.join(allowed, 'out');
    fs.mkdirSync(allowed);
    localDb = await initDatabase(path.join(root, 'desktop', 'fileshuttle.db'));
    const mapping = (name: string, from: string, to: string, extra: object = {}) => ({
      name, sourcePath: from, destPath: to, recursive: false, conflictPolicy: 'skip' as const, enabled: true, scheduleType: 'manual' as const,
      scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null, actionType: 'move' as const, keepNewest: null,
      keepNewestPerExtension: false, ...extra,
    });
    const m1 = repo.createMapping(localDb, mapping('shuttle', src, dest));
    repo.createMapping(localDb, mapping('unused', src, path.join(allowed, 'other')));
    repo.createJob(localDb, { name: 'shuttle job', enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [m1] });
    const dbFile = path.join(root, 'desktop', 'fileshuttle.db');
    const dbBefore = repo.listMappings(localDb).length;

    const localDbRef = localDb;
    manager = new RemoteHubManager({
      dir: path.join(root, 'desktop', 'remote-hub'),
      appVersion: '9.9.9',
      localHub: {
        suspend: async () => void events.push('local hub off'),
        resume: async () => void events.push('local hub on'),
      },
      buildSetup: () => buildSetupPayload(localDbRef),
      backoffStartMs: 50,
      backoffMaxMs: 200,
      heartbeat: false,
      hostName: () => 'Desktop PC',
    });

    // A bad address and a wrong code change nothing.
    await expect(manager.enable({ hubUrl: 'http://example.com', code: 'AAAA-BBBB', name: '', allowedFolders: [allowed] })).rejects.toThrow(/https/);
    await expect(manager.enable({ hubUrl: base(), code: 'AAAA-BBBB', name: '', allowedFolders: [allowed] })).rejects.toThrow(RemoteHubError);
    expect(manager.state().enabled).toBe(false);
    expect(events).toEqual([]);

    // Pair and switch over.
    const { code } = await rpc('workers:createPairCode', [], cookie);
    const state = await manager.enable({ hubUrl: base(), code, name: '', allowedFolders: [allowed] });
    expect(state).toMatchObject({ enabled: true, name: 'Desktop PC', allowedFolders: [allowed] });
    expect(events).toEqual(['local hub off']);
    expect(manager.isEnabled()).toBe(true);
    expect(manager.hubOrigin()).toBe(base());
    expect(fs.statSync(path.join(root, 'desktop', 'remote-hub', 'worker-token')).mode & 0o777).toBe(0o600);
    await until(() => manager!.state().connected, 'the desktop worker to connect');
    const machines = await rpc('workers:list', [], cookie);
    const mine = machines.find((w: { name: string }) => w.name === 'Desktop PC');
    expect(mine).toMatchObject({ kind: 'remote', online: true });

    // Send the setup: it lands on this machine, switched off. A second send skips everything.
    const first = await manager.sendSetup();
    expect(first).toMatchObject({ mappingsSent: 2, jobsSent: 1, mappingsSkipped: [], jobsSkipped: [] });
    const second = await manager.sendSetup();
    expect(second.mappingsSent).toBe(0);
    expect(second.mappingsSkipped.map((s) => s.name).sort()).toEqual(['shuttle', 'unused']);
    expect(second.jobsSkipped.map((s) => s.name)).toEqual(['shuttle job']);
    const hubJobs = (await rpc('jobs:list', [], cookie)).filter((j: { workerId: string }) => j.workerId === mine.id);
    expect(hubJobs).toHaveLength(1);
    expect(hubJobs[0].enabled).toBe(false);
    // The local database is untouched.
    expect(repo.listMappings(localDb).length).toBe(dbBefore);
    expect(repo.listJobs(localDb)).toHaveLength(1);
    expect(fs.existsSync(dbFile)).toBe(true);

    // The hub runs that job on this computer's worker.
    await rpc('jobs:setEnabled', [hubJobs[0].id, true], cookie);
    writeFile(path.join(src, 'a.txt'), 'A');
    await new Promise((r) => setTimeout(r, 200));
    const result = await rpc('jobs:run', [hubJobs[0].id], cookie);
    expect(result.filesMoved).toBe(1);
    expect(listTree(dest)).toEqual(['a.txt']);

    // An empty folder list refuses everything (and says so).
    const refused = await manager.setAllowedFolders([]);
    expect(refused.allowedFolders).toEqual([]);
    await until(() => manager!.state().connected, 'the worker to reconnect');
    await new Promise((r) => setTimeout(r, 200));
    writeFile(path.join(src, 'b.txt'), 'B');
    await rpc('jobs:run', [hubJobs[0].id], cookie);
    expect(listTree(src)).toEqual(['b.txt']);
    expect((await rpc('history:list', [{ jobId: hubJobs[0].id }], cookie))[0].errorMessage).toMatch(/no allowed folders/);

    // Turning it off: token gone, nothing revoked on the hub, the local hub is back, and it stays off after a "restart".
    const off = await manager.disable();
    expect(off.enabled).toBe(false);
    expect(events).toEqual(['local hub off', 'local hub on']);
    expect(fs.existsSync(path.join(root, 'desktop', 'remote-hub', 'worker-token'))).toBe(false);
    expect(manager.hubOrigin()).toBeNull();
    await until(async () => !(await rpc('workers:list', [], cookie)).find((w: { id: string }) => w.id === mine.id).online, 'the machine to go offline');
    expect((await rpc('workers:list', [], cookie)).map((w: { id: string }) => w.id)).toContain(mine.id);
    await expect(manager.sendSetup()).rejects.toThrow(/Turn on/);
    expect(repo.listMappings(localDb).length).toBe(dbBefore);
  }, 60_000);

  it('is on again after a restart, and reports an unreachable hub', async () => {
    hub = await startServer('hub', config, () => undefined);
    await setRemotePassword(hub.db, PASSWORD);
    const login = await fetch(`${base()}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fileshuttle': '1', origin: base() },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const dir = path.join(root, 'desktop', 'remote-hub');
    const make = () =>
      new RemoteHubManager({
        dir, appVersion: '9.9.9', localHub: { suspend: async () => undefined, resume: async () => undefined },
        buildSetup: () => ({ mappings: [], jobs: [] }), backoffStartMs: 50, backoffMaxMs: 200, heartbeat: false, hostName: () => 'Desk',
      });
    manager = make();
    const { code } = await rpc('workers:createPairCode', [], cookie);
    await manager.enable({ hubUrl: base(), code, name: 'Desk', allowedFolders: [] });
    expect(await manager.hubReachable()).toBe(true);
    manager.shutdown();

    // A new process: settings and token come from disk; launch goes to the remote page.
    manager = make();
    expect(manager.isEnabled()).toBe(true);
    expect(manager.hubOrigin()).toBe(base());
    await manager.resumeAtLaunch();
    await until(() => manager!.state().connected, 'the worker to reconnect after the restart');

    manager.shutdown();
    await hub.stop();
    hub = null;
    expect(await manager.hubReachable(500)).toBe(false);
  }, 60_000);
});
