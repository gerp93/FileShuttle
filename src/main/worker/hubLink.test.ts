import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { setDefaultTrash } from '../engine/trash';
import { createPairingCode } from '../hub/pairing';
import { startServer, RunningServer } from '../../server/server';
import { runSettings } from '../settings/appSettings';
import { HubLink } from './hubLink';
import { createTokenStore } from './tokenStore';
import { WORKER_OFFLINE_AFTER_MS } from '../../shared/workerProtocol';

vi.mock('../startupLog', () => ({
  logStartupStep: () => undefined,
  setStartupLogToFile: () => undefined,
  setStartupLogQuiet: () => undefined,
}));

let root: string;
let hub: RunningServer | null = null;
let pc: Database;
let link: HubLink | null = null;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-hublink-');
  writeFile(path.join(root, 'web', 'index.html'), '<!doctype html><title>FileShuttle</title>');
  setDefaultTrash(null);
  hub = await startServer(
    'hub',
    {
      dataDir: path.join(root, 'hub'),
      port: 0,
      host: '127.0.0.1',
      webDir: path.join(root, 'web'),
      trashDir: path.join(root, 'hub', 'Trash'),
    },
    () => undefined
  );
  // The PC app's own database: separate from the hub's.
  pc = await initDatabase(path.join(root, 'pc', 'fileshuttle.db'));
});
afterEach(async () => {
  link?.stop();
  link = null;
  await hub?.stop();
  hub = null;
  pc.close();
  removeDir(root);
});

const hubUrl = () => `http://127.0.0.1:${hub!.address.port}`;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function newLink(): HubLink {
  link = new HubLink({
    dataDir: path.join(root, 'pc-link'),
    appVersion: '0.0.0-test',
    readRunSettings: () => runSettings.read(pc),
    backoffStartMs: 50,
    backoffMaxMs: 200,
    heartbeat: false,
    // The real token store: DPAPI on Windows, a 0600 file elsewhere.
    tokenStore: createTokenStore(path.join(root, 'pc-link')),
  });
  return link;
}

function addPcJob(name: string, src: string, dest: string, lastRunAt: string | null): { mappingId: number; jobId: number } {
  const mappingId = repo.createMapping(pc, {
    name: `${name} step`, sourcePath: src, destPath: dest, recursive: false, conflictPolicy: 'skip', enabled: true,
    scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null,
    actionType: 'move', keepNewest: null, keepNewestPerExtension: false,
  });
  const jobId = repo.createJob(pc, {
    name, enabled: true, catchUp: true, scheduleType: 'daily_at', scheduleIntervalMinutes: null, scheduleDailyTimes: ['04:00'],
    mappingIds: [mappingId],
  });
  if (lastRunAt) repo.setJobLastRun(pc, jobId, lastRunAt);
  return { mappingId, jobId };
}

describe('the desktop app as a worker for a hub', () => {
  it('pairs, keeps its token protected, brings its jobs to the hub, runs them on its own folders and disconnects', async () => {
    const link = newLink();
    expect(link.state()).toMatchObject({ paired: false, online: false, allowedFolders: [] });

    const { code } = createPairingCode(hub!.db);
    const connected = await link.connect({ hubUrl: hubUrl(), code, name: 'KVG PC' });
    expect(connected).toMatchObject({ paired: true, name: 'KVG PC', hubUrl: hubUrl() });
    const workerId = connected.workerId!;
    // No allowed folder yet: it says so, and nothing would run.
    expect(connected.problem).toMatch(/allow/i);
    // The token is never in a file in the clear.
    const files = fs.readdirSync(path.join(root, 'pc-link')).map((f) => path.join(root, 'pc-link', f)).filter((f) => fs.statSync(f).isFile());
    const token = await createTokenStore(path.join(root, 'pc-link')).load();
    expect(token).toMatch(/^fsw_/);
    if (process.platform === 'win32') {
      for (const f of files) expect(fs.readFileSync(f, 'latin1')).not.toContain(token!);
    }
    await until(() => hub!.hub.isOnline(workerId), 'the PC to be online at the hub');

    // This app's own data: two jobs, one that already ran today (so connecting must not make it look overdue).
    const area = path.join(root, 'pc-files');
    const { jobId } = addPcJob('inbox', path.join(area, 'in'), path.join(area, 'out'), new Date().toISOString());
    const second = addPcJob('overdue', path.join(area, 'in2'), path.join(area, 'out2'), '2026-01-01T00:00:00.000Z');
    writeFile(path.join(area, 'in', 'a.txt'), 'A');

    await link.setAllowedFolders([area]);
    expect(link.state().allowedFolders).toEqual([area]);
    await until(() => hub!.hub.isOnline(workerId), 'the PC to be back online after the folders changed');

    const sent = await link.sendDefinitions({ mappings: repo.listMappings(pc), jobs: repo.listJobs(pc) });
    expect(sent).toEqual({ mappings: 2, jobs: 2 });
    // On the hub they belong to the PC's machine, not the hub's own.
    const hubJobs = repo.listJobs(hub!.db);
    expect(hubJobs).toHaveLength(2);
    expect(hubJobs.every((j) => j.workerId === workerId)).toBe(true);
    expect(hubJobs.find((j) => j.name === 'inbox')).toMatchObject({ enabled: true, catchUp: true, scheduleDailyTimes: ['04:00'] });
    expect(hubJobs.find((j) => j.name === 'inbox')!.lastRunAt).toBe(repo.getJob(pc, jobId)!.lastRunAt);
    // The PC's own data is untouched.
    expect(repo.listJobs(pc)).toHaveLength(2);
    expect(repo.getJob(pc, second.jobId)!.workerId).not.toBe(workerId);

    // A second import is refused, and creates nothing.
    await expect(link.sendDefinitions({ mappings: repo.listMappings(pc), jobs: repo.listJobs(pc) })).rejects.toThrow(/already has/);
    expect(repo.listJobs(hub!.db)).toHaveLength(2);

    // The hub runs a job; the PC does the work on its own folder, and the hub records it.
    const hubJob = hubJobs.find((j) => j.name === 'inbox')!;
    await until(() => link.state().queuedReports === 0, 'an empty outbox');
    const result = await hub!.hub.runJob(hubJob.id, 'manual');
    expect(result.filesMoved).toBe(1);
    expect(listTree(path.join(area, 'out'))).toEqual(['a.txt']);
    expect(repo.listRuns(hub!.db, { jobId: hubJob.id })[0]).toMatchObject({ workerId, filesMoved: 1 });

    // Disconnecting forgets everything about the hub and leaves the PC's own data alone.
    await link.disconnect();
    expect(link.state()).toMatchObject({ paired: false, hubUrl: null, queuedReports: 0, online: false });
    expect(await createTokenStore(path.join(root, 'pc-link')).load()).toBeNull();
    expect(fs.existsSync(path.join(root, 'pc-link', 'schedule.json'))).toBe(false);
    expect(repo.listJobs(pc)).toHaveLength(2);
    expect(WORKER_OFFLINE_AFTER_MS).toBeGreaterThan(0);
  }, 30_000);

  it('can leave the imported jobs switched off', async () => {
    const link = newLink();
    const { code } = createPairingCode(hub!.db);
    await link.connect({ hubUrl: hubUrl(), code, name: 'KVG PC' });
    addPcJob('inbox', path.join(root, 'a'), path.join(root, 'b'), null);
    await link.sendDefinitions({ mappings: repo.listMappings(pc), jobs: repo.listJobs(pc) }, { switchOff: true });
    expect(repo.listJobs(hub!.db).map((j) => j.enabled)).toEqual([false]);
  });

  it('refuses a hub address that is not https, and a wrong code, and stays unpaired', async () => {
    const link = newLink();
    await expect(link.connect({ hubUrl: 'http://holocron:8765', code: 'ABCD-2345' })).rejects.toThrow(/https/);
    await expect(link.connect({ hubUrl: hubUrl(), code: 'ABCD-2345' })).rejects.toThrow(/code/i);
    expect(link.state().paired).toBe(false);
    expect(fs.existsSync(path.join(root, 'pc-link', 'worker.json'))).toBe(false);
  });

  it('starts again from what is on disk after the app restarts', async () => {
    const first = newLink();
    const { code } = createPairingCode(hub!.db);
    const state = await first.connect({ hubUrl: hubUrl(), code, name: 'KVG PC' });
    first.stop();
    await until(() => !hub!.hub.isOnline(state.workerId!), 'the hub to see it leave');

    const second = newLink();
    expect(second.isPaired()).toBe(true);
    expect(await second.start()).toBe(true);
    await until(() => hub!.hub.isOnline(state.workerId!), 'the PC to come back');
  });

  it('does not send anything when it is not connected', async () => {
    await expect(newLink().sendDefinitions({ mappings: [], jobs: [] })).rejects.toThrow(/not connected/);
  });
});
