import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import { initDatabase } from '../database/schema';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { DESKTOP_CHANNELS, HTTP_CHANNELS } from './channels';
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
  'mcp:listTokens', 'mcp:createToken', 'mcp:revokeToken',
  'hubLink:getState', 'hubLink:connect', 'hubLink:disconnect', 'hubLink:setAllowedFolders', 'hubLink:suggestFolders',
  'hubLink:sendDefinitions', 'hubLink:openHub',
  'workers:list', 'workers:createPairCode', 'workers:remove',
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
});
