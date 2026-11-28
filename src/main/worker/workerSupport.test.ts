import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { HubUrlError, pairWithHub, validateHubUrl } from './hubClient';
import { Outbox } from './outbox';
import { createTokenStore } from './tokenStore';
import { createScheduleStore, defaultWorkerDataDir, loadWorkerConfig, savePairing, splitFolderList } from './workerConfig';
import type { WorkerToHub } from '../../shared/workerProtocol';

let root: string;
beforeEach(() => {
  root = makeTempDir('fileshuttle-worker-support-');
});
afterEach(() => removeDir(root));

const linuxOnly = it.skipIf(process.platform === 'win32');

describe('validateHubUrl', () => {
  it('accepts https, and http only for this computer itself', () => {
    expect(validateHubUrl('https://hub.example.ts.net')).toBe('https://hub.example.ts.net');
    expect(validateHubUrl('https://hub.example.ts.net:8443/')).toBe('https://hub.example.ts.net:8443');
    expect(validateHubUrl('http://127.0.0.1:8765')).toBe('http://127.0.0.1:8765');
    expect(validateHubUrl('http://localhost:8765')).toBe('http://localhost:8765');
    expect(validateHubUrl('http://[::1]:8765')).toBe('http://[::1]:8765');
  });

  it('refuses everything else before any request is made', () => {
    for (const bad of [
      'http://hub.example.ts.net',
      'http://192.168.1.5:8765',
      'http://127.0.0.1.evil.example',
      'http://localhost.evil.example',
      'ftp://hub.example',
      'hub.example.ts.net',
      '',
      'https://user:pw@hub.example.ts.net',
      'https://hub.example.ts.net/some/path',
      'https://hub.example.ts.net/?x=1',
      'https://hub.example.ts.net/#frag',
      'ws://127.0.0.1:8765',
    ]) {
      expect(() => validateHubUrl(bad), bad).toThrow(HubUrlError);
    }
  });
});

describe('pairWithHub', () => {
  it('refuses a bad address without calling fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    await expect(pairWithHub({ hubUrl: 'http://example.com', code: 'AAAA-BBBB', fetchImpl })).rejects.toThrow(/https/);
    expect(called).toBe(false);
  });

  it('posts the code and returns the id and token; errors carry the hub’s plain sentence', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, workerId: 'w1', name: 'Garage', token: 'fsw_x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(pairWithHub({ hubUrl: 'https://hub.example.ts.net', code: 'AAAA-BBBB', name: 'Garage', fetchImpl: ok })).resolves.toEqual({
      workerId: 'w1', name: 'Garage', token: 'fsw_x',
    });
    expect(seen!.url).toBe('https://hub.example.ts.net/api/workers/pair');
    expect(seen!.init.redirect).toBe('error');
    expect(String(seen!.url)).not.toContain('AAAA');
    const refused = (async () => new Response(JSON.stringify({ ok: false, error: 'That pairing code is not valid.' }), { status: 401 })) as unknown as typeof fetch;
    await expect(pairWithHub({ hubUrl: 'https://hub.example.ts.net', code: 'x', fetchImpl: refused })).rejects.toThrow('That pairing code is not valid.');
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(pairWithHub({ hubUrl: 'https://hub.example.ts.net', code: 'x', fetchImpl: down })).rejects.toThrow(/Could not reach the hub/);
  });
});

describe('token store', () => {
  linuxOnly('writes a file only its owner can read, in a folder only its owner can open', async () => {
    const dir = path.join(root, 'worker');
    const store = createTokenStore(dir, { platform: 'linux' });
    expect(await store.load()).toBeNull();
    await store.save('fsw_secret');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['worker-token']);
    expect(fs.statSync(path.join(dir, 'worker-token')).mode & 0o777).toBe(0o600);
    expect(await store.load()).toBe('fsw_secret');
    await store.save('fsw_second');
    expect(await store.load()).toBe('fsw_second');
    expect(fs.readdirSync(dir)).toEqual(['worker-token']); // no temp file left behind
  });

  linuxOnly('tightens a file somebody loosened', async () => {
    const dir = path.join(root, 'worker');
    const store = createTokenStore(dir, { platform: 'linux' });
    await store.save('fsw_secret');
    fs.chmodSync(path.join(dir, 'worker-token'), 0o644);
    fs.chmodSync(dir, 0o755);
    expect(await store.load()).toBe('fsw_secret');
    expect(fs.statSync(path.join(dir, 'worker-token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('on Windows seals the token with DPAPI, and the file never holds it in the clear', async () => {
    const dir = path.join(root, 'win');
    const calls: Array<[string, string]> = [];
    // A stand-in for PowerShell: "protects" by reversing the base64 text.
    const dpapi = async (mode: 'protect' | 'unprotect', input: string) => {
      calls.push([mode, input]);
      return mode === 'protect' ? `sealed:${input}` : input.replace(/^sealed:/, '');
    };
    const store = createTokenStore(dir, { platform: 'win32', dpapi });
    expect(await store.load()).toBeNull();
    await store.save('fsw_secret');
    const file = fs.readFileSync(path.join(dir, 'worker-token.dpapi'), 'utf8');
    expect(file).not.toContain('fsw_secret');
    expect(fs.existsSync(path.join(dir, 'worker-token'))).toBe(false);
    expect(await store.load()).toBe('fsw_secret');
    expect(calls.map((c) => c[0])).toEqual(['protect', 'unprotect']);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('outbox', () => {
  const run = (uid: string): WorkerToHub => ({ type: 'jobFinished', workerId: 'w', jobId: 1, startedAt: uid, completed: true });

  it('keeps entries across restarts, in order, until they are removed', () => {
    const dir = path.join(root, 'outbox');
    const box = new Outbox(dir);
    box.add('a', run('a'));
    box.add('b', run('b'));
    box.add('a', run('a again')); // same id: kept once
    expect(box.size).toBe(2);
    const again = new Outbox(dir);
    expect(again.pending().map((m) => (m as { startedAt: string }).startedAt)).toEqual(['a', 'b']);
    again.remove('a');
    again.remove('unknown');
    expect(new Outbox(dir).pending().map((m) => (m as { startedAt: string }).startedAt)).toEqual(['b']);
  });

  it('sets a corrupt file aside and drops an unfinished write', () => {
    const dir = path.join(root, 'outbox');
    const box = new Outbox(dir);
    box.add('a', run('a'));
    fs.writeFileSync(path.join(dir, '000000000000001-000000.json'), '{ not json');
    fs.writeFileSync(path.join(dir, '000000000000002-000000.json.tmp'), 'half');
    const reopened = new Outbox(dir);
    expect(reopened.size).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual([expect.stringMatching(/\.json$/), '000000000000001-000000.json.bad'].sort());
  });
});

describe('worker config', () => {
  it('has a per-user default folder on each platform', () => {
    expect(defaultWorkerDataDir({ XDG_DATA_HOME: '/x/share' }, 'linux', '/home/u')).toBe(path.join('/x/share', 'fileshuttle-worker'));
    expect(defaultWorkerDataDir({}, 'darwin', '/Users/u')).toBe(path.join('/Users/u', '.local', 'share', 'fileshuttle-worker'));
    expect(defaultWorkerDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Local\\FileShuttleWorker');
  });

  it('reads worker.json, lets the environment override it, and splits the folder list by the platform separator', () => {
    const dir = path.join(root, 'cfg');
    savePairing(dir, { hubUrl: 'https://hub.example.ts.net', workerId: 'w1', name: 'Garage' });
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'worker.json'), 'utf8')), allowedFolders: ['/srv/a'] }));
    expect(loadWorkerConfig({ FILESHUTTLE_WORKER_DATA_DIR: dir })).toMatchObject({ hubUrl: 'https://hub.example.ts.net', workerId: 'w1', name: 'Garage', allowedFolders: ['/srv/a'] });
    const env = loadWorkerConfig({ FILESHUTTLE_WORKER_DATA_DIR: dir, FILESHUTTLE_WORKER_NAME: 'Other', FILESHUTTLE_WORKER_HUB: 'https://x.example', FILESHUTTLE_WORKER_ALLOWED_FOLDERS: '' });
    expect(env).toMatchObject({ name: 'Other', hubUrl: 'https://x.example', allowedFolders: [] });
    expect(splitFolderList('/a:/b::/c ', ':')).toEqual(['/a', '/b', '/c']);
    expect(splitFolderList('C:\\a;D:\\b', ';')).toEqual(['C:\\a', 'D:\\b']);
    expect(() => loadWorkerConfig({ FILESHUTTLE_WORKER_DATA_DIR: 'relative' })).toThrow(/absolute/);
  });

  it('saving a pairing keeps the allowed folders already written', () => {
    const dir = path.join(root, 'cfg');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ allowedFolders: ['/keep'] }));
    savePairing(dir, { hubUrl: 'https://h.example', workerId: 'w', name: 'n' });
    expect(loadWorkerConfig({ FILESHUTTLE_WORKER_DATA_DIR: dir }).allowedFolders).toEqual(['/keep']);
  });

  it('keeps a schedule copy that survives a restart', () => {
    const store = createScheduleStore(path.join(root, 'cfg'));
    expect(store.load()).toBeNull();
    store.save(3, { mappings: [], jobs: [] });
    expect(createScheduleStore(path.join(root, 'cfg')).load()).toEqual({ version: 3, schedule: { mappings: [], jobs: [] } });
  });
});
