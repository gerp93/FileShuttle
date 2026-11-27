import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { RemoteController } from './controller';
import {
  checkRemotePassword,
  getRemoteSettings,
  parseLogins,
  setRemotePassword,
  setRemoteSettings,
} from './remoteSettings';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-remote-settings-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
});
afterEach(() => {
  db.close();
  removeDir(root);
});

describe('remote settings', () => {
  it('is off by default', () => {
    expect(getRemoteSettings(db)).toEqual({ enabled: false, port: 8765, hasPassword: false, allowedLogins: [] });
  });

  it('refuses to turn on without a password', () => {
    expect(() => setRemoteSettings(db, { enabled: true })).toThrow(/password/i);
    expect(getRemoteSettings(db).enabled).toBe(false);
  });

  it('stores only a hash of the password, and checks it', async () => {
    await expect(setRemotePassword(db, 'short')).rejects.toThrow(/8 characters/);
    await setRemotePassword(db, 'a long enough password');
    const stored = repo.getSetting(db, 'remote_password_hash');
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('a long enough password');
    expect(await checkRemotePassword(db, 'a long enough password')).toBe(true);
    expect(await checkRemotePassword(db, 'another password!')).toBe(false);
    expect(getRemoteSettings(db).hasPassword).toBe(true);
    setRemoteSettings(db, { enabled: true });
    expect(getRemoteSettings(db).enabled).toBe(true);
  });

  it('validates the port and cleans up the allowed logins', () => {
    expect(() => setRemoteSettings(db, { port: 80 })).toThrow(/port/);
    expect(() => setRemoteSettings(db, { port: 70000 })).toThrow(/port/);
    expect(() => setRemoteSettings(db, { port: 1.5 })).toThrow(/port/);
    setRemoteSettings(db, { port: 9100, allowedLogins: [' a@b.com ', 'A@B.com', '', 'c@d.org'] });
    expect(getRemoteSettings(db)).toMatchObject({ port: 9100, allowedLogins: ['a@b.com', 'c@d.org'] });
    expect(parseLogins('x@y.z, p@q.r\nx@y.z')).toEqual(['x@y.z', 'p@q.r']);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

describe('RemoteController', () => {
  it('starts and stops the server as the settings change', async () => {
    writeFile(path.join(root, 'www', 'index.html'), '<html></html>');
    const controller = new RemoteController({
      getDb: () => db,
      handlers: { 'app:getVersion': () => '1' },
      staticDir: path.join(root, 'www'),
    });
    await controller.apply();
    expect(controller.state().status.listening).toBe(false);

    await controller.setPassword('a long enough password');
    const port = await freePort();
    let state = await controller.setSettings({ port, enabled: true });
    expect(state.status).toEqual({ listening: true, address: `http://127.0.0.1:${port}`, error: null });
    expect(await get(port, '/')).toBe(200);

    state = await controller.setSettings({ enabled: false });
    expect(state.status.listening).toBe(false);
    await expect(get(port, '/')).rejects.toThrow();
    await controller.shutdown();
  });

  it('reports a busy port instead of throwing', async () => {
    writeFile(path.join(root, 'www', 'index.html'), '<html></html>');
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    const controller = new RemoteController({
      getDb: () => db,
      handlers: {},
      staticDir: path.join(root, 'www'),
    });
    await controller.setPassword('a long enough password');
    const state = await controller.setSettings({ port, enabled: true });
    expect(state.status.listening).toBe(false);
    expect(state.status.error).toMatch(/already in use/);
    blocker.close();
    await controller.shutdown();
  });
});
