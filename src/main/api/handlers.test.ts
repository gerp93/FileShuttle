import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import { initDatabase } from '../database/schema';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { DESKTOP_CHANNELS, HTTP_CHANNELS } from './channels';
import { Hub } from '../hub/hub';
import * as repo from '../database/repository';
import { getLocalWorkerId } from '../database/workers';
import { createPairing, redeemPairing } from '../database/workerAccess';
import type { WorkerInfo } from '../../shared/types';
import { createHandlers } from './handlers';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

// Every channel main.ts registered before the handler table existed.
const LEGACY_CHANNELS = [
  'mappings:list', 'mappings:get', 'mappings:create', 'mappings:update', 'mappings:delete', 'mappings:clone',
  'mappings:preview', 'mappings:previewInput', 'mappings:listJobsUsing', 'mappings:setEnabled', 'mappings:getStats',
  'jobs:list', 'jobs:get', 'jobs:create', 'jobs:update', 'jobs:delete', 'jobs:setEnabled', 'jobs:getStats',
  'jobs:preview', 'jobs:cancel', 'jobs:getActive', 'jobs:run', 'jobs:runAll',
  'history:list', 'history:getDetail', 'history:undo', 'history:purgeAll',
  'settings:getTheme', 'settings:setTheme', 'settings:getStartup', 'settings:setStartup',
  'settings:getOverwriteBackup', 'settings:setOverwriteBackup', 'settings:getUnzipLimits', 'settings:setUnzipLimits',
  'settings:getLogRetention', 'settings:setLogRetention',
  'dialogs:pickFolder', 'dialogs:checkFolder', 'shell:openPath',
  'dbLocation:get', 'dbLocation:browseExisting', 'dbLocation:browseNew', 'dbLocation:set', 'dbLocation:resetToDefault',
  'app:getVersion', 'updates:check',
];

const NEW_CHANNELS = [
  'dialogs:listFolder', 'remote:getSettings', 'remote:setSettings', 'remote:setPassword',
  'mcp:listTokens', 'mcp:createToken', 'mcp:revokeToken', 'workers:list',
];

function makeHandlers(db: Database | null = null) {
  const reloadJobs = vi.fn();
  const handlers = createHandlers({ getDb: () => db!, reloadJobs, getVersion: () => '9.9.9' });
  return { handlers, reloadJobs };
}

describe('handler table', () => {
  it('covers every channel the renderer used before, plus the new ones, and nothing else', () => {
    const { handlers } = makeHandlers();
    const all = new Set([...Object.keys(handlers), ...DESKTOP_CHANNELS]);
    for (const channel of LEGACY_CHANNELS) expect(all.has(channel), channel).toBe(true);
    expect([...all].sort()).toEqual([...LEGACY_CHANNELS, ...NEW_CHANNELS].sort());
  });

  it('keeps shared and desktop-only channels apart', () => {
    const { handlers } = makeHandlers();
    for (const channel of DESKTOP_CHANNELS) expect(channel in handlers, channel).toBe(false);
    expect([...HTTP_CHANNELS].sort()).toEqual(Object.keys(handlers).sort());
  });

  it('never exposes desktop-only things over HTTP', () => {
    for (const channel of HTTP_CHANNELS) {
      expect(channel).not.toMatch(/^(shell|dbLocation|remote|mcp|updates):/);
    }
    expect(HTTP_CHANNELS).not.toContain('dialogs:pickFolder');
    expect(HTTP_CHANNELS).not.toContain('settings:setStartup');
    expect(HTTP_CHANNELS).not.toContain('settings:getStartup');
  });

  it('matches the channels the preload script invokes', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.ts'), 'utf8');
    const used = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
    const { handlers } = makeHandlers();
    const known = new Set([...Object.keys(handlers), ...DESKTOP_CHANNELS]);
    expect(used.length).toBeGreaterThan(40);
    for (const channel of used) expect(known.has(channel), channel).toBe(true);
  });
});

describe('handlers over a real database', () => {
  let root: string;
  let db: Database;
  beforeEach(async () => {
    root = makeTempDir('fileshuttle-handlers-');
    db = await initDatabase(path.join(root, 'fileshuttle.db'));
  });
  afterEach(() => {
    db.close();
    removeDir(root);
  });

  it('reads, saves and reloads schedules like the old IPC handlers did', async () => {
    const { handlers, reloadJobs } = makeHandlers(db);
    expect(await handlers['mappings:list']()).toEqual([]);
    expect(await handlers['app:getVersion']()).toBe('9.9.9');
    expect(await handlers['settings:getTheme']()).toBe('blue_oval');

    await handlers['settings:setTheme']('hacker');
    expect(await handlers['settings:getTheme']()).toBe('hacker');

    expect(() => handlers['mappings:create']({})).toThrow();
    expect(reloadJobs).not.toHaveBeenCalled();
  });
  it('lists the computers, and saves a mapping or job on the one it is told to (and refuses one that does not exist)', async () => {
    const hub = new Hub({ getDb: () => db });
    const handlers = createHandlers({ getDb: () => db, hub, reloadJobs: vi.fn(), getVersion: () => '9.9.9' });
    const remote = redeemPairing(db, createPairing(db, { name: 'KVG PC' }).code)!;

    const listed = (await handlers['workers:list']()) as WorkerInfo[];
    expect(listed.map((w) => [w.name === 'KVG PC' ? 'KVG PC' : 'hub', w.kind, w.online, w.paired])).toEqual([
      ['hub', 'local', false, true],
      ['KVG PC', 'remote', false, true],
    ]);

    const input = {
      name: 'm', sourcePath: path.join(root, 'a'), destPath: path.join(root, 'b'), recursive: false, conflictPolicy: 'skip',
      enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [],
      nextMappingId: null, actionType: 'move', keepNewest: null, keepNewestPerExtension: false,
    };
    const mappingId = handlers['mappings:create'](input, remote.workerId) as number;
    expect(repo.getMapping(db, mappingId)!.workerId).toBe(remote.workerId);
    expect(repo.getMapping(db, handlers['mappings:create'](input) as number)!.workerId).toBe(getLocalWorkerId(db));
    expect(() => handlers['mappings:create'](input, 'no-such-worker')).toThrow(/no such computer/);

    const jobId = handlers['jobs:create'](
      { name: 'j', enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId] },
      remote.workerId
    ) as number;
    expect(repo.getJob(db, jobId)!.workerId).toBe(remote.workerId);
    // a job's steps must all belong to its computer
    expect(() =>
      handlers['jobs:create']({ name: 'mixed', enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mappingId] })
    ).toThrow();
    // nothing can be asked of a computer that is not connected
    await expect(handlers['dialogs:listFolder'](root, remote.workerId)).rejects.toThrow(/not connected/);
  });
});
