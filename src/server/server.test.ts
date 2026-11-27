import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listTree, makeTempDir, removeDir, writeFile } from '../main/engine/testUtils';
import { setRemotePassword } from '../main/remote/remoteSettings';
import { setDefaultTrash } from '../main/engine/trash';
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
let running: RunningServer | null = null;

beforeEach(() => {
  root = makeTempDir('fileshuttle-server-');
  writeFile(path.join(root, 'web', 'index.html'), '<!doctype html><title>FileShuttle</title>');
  config = {
    dataDir: path.join(root, 'data'),
    port: 0,
    host: '127.0.0.1',
    webDir: path.join(root, 'web'),
    trashDir: path.join(root, 'data', 'Trash'),
  };
  setDefaultTrash(null);
});
afterEach(async () => {
  await running?.stop();
  running = null;
  removeDir(root);
});

const base = () => `http://127.0.0.1:${running!.address.port}`;
const post = (url: string, body: unknown, cookie?: string) =>
  fetch(base() + url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fileshuttle': '1',
      origin: base(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

async function signIn(): Promise<string> {
  const res = await post('/api/login', { password: PASSWORD });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('headless server (all)', () => {
  it('serves the web UI, requires the password, and answers the API', async () => {
    running = await startServer('all', config, () => undefined);
    expect(running.address.host).toBe('127.0.0.1');
    expect(running.hasPassword()).toBe(false);

    const page = await fetch(base() + '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('FileShuttle');

    // No password yet: nobody can sign in.
    expect((await post('/api/login', { password: PASSWORD })).status).toBe(503);

    await setRemotePassword(running.db, PASSWORD);
    expect((await post('/api/login', { password: 'wrong-password-1' })).status).toBe(401);
    expect((await post('/api/rpc/app:getVersion', [])).status).toBe(401);

    const cookie = await signIn();
    const version = await (await post('/api/rpc/app:getVersion', [], cookie)).json();
    expect(version).toEqual({ ok: true, result: '0.0.0-dev' });
    // Desktop-only channels stay unreachable.
    expect((await post('/api/rpc/dbLocation:get', [], cookie)).status).toBe(404);
  });

  it('runs a delete job through its own worker into the trash, and Undo restores the file', async () => {
    running = await startServer('all', config, () => undefined);
    await setRemotePassword(running.db, PASSWORD);
    const cookie = await signIn();

    const src = path.join(root, 'inbox');
    writeFile(path.join(src, 'old.txt'), 'precious');
    const mapping = await (
      await post(
        '/api/rpc/mappings:create',
        [{
          name: 'cleanup', sourcePath: src, destPath: '', recursive: false, conflictPolicy: 'skip', enabled: true,
          scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], nextMappingId: null,
          actionType: 'delete', keepNewest: null, keepNewestPerExtension: false,
        }],
        cookie
      )
    ).json();
    expect(mapping.ok).toBe(true);
    const job = await (
      await post(
        '/api/rpc/jobs:create',
        [{ name: 'cleanup job', enabled: true, scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [mapping.result] }],
        cookie
      )
    ).json();
    expect(job.ok).toBe(true);

    const run = await (await post('/api/rpc/jobs:run', [job.result], cookie)).json();
    expect(run.ok).toBe(true);
    expect(run.result.filesDeleted).toBe(1);
    expect(listTree(src)).toEqual([]);
    // Trashed (freedesktop layout inside the data folder), never deleted outright.
    expect(fs.readFileSync(path.join(config.trashDir, 'files', 'old.txt'), 'utf8')).toBe('precious');
    expect(fs.readdirSync(path.join(config.trashDir, 'info'))).toEqual(['old.txt.trashinfo']);

    const history = await (await post('/api/rpc/history:list', [{ jobId: job.result }], cookie)).json();
    const undo = await (await post('/api/rpc/history:undo', [history.result[0].id], cookie)).json();
    expect(undo.ok).toBe(true);
    expect(fs.readFileSync(path.join(src, 'old.txt'), 'utf8')).toBe('precious');
  });

  it('hub mode has no local worker', async () => {
    running = await startServer('hub', config, () => undefined);
    expect(running.worker).toBeNull();
  });

  it('stops cleanly and can be started again on the same data', async () => {
    running = await startServer('all', config, () => undefined);
    await running.stop();
    running = await startServer('all', config, () => undefined);
    expect((await fetch(base() + '/')).status).toBe(200);
  });
});
