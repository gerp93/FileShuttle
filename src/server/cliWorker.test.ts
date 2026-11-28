import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '../main/engine/testUtils';
import { runCli } from './cli';
import { startServer, RunningServer } from './server';
import { parseServerConfig } from './config';

vi.mock('../main/startupLog', () => ({
  logStartupStep: () => undefined,
  setStartupLogToFile: () => undefined,
  setStartupLogQuiet: () => undefined,
}));

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = makeTempDir('fileshuttle-cliw-');
  process.env.FILESHUTTLE_SERVER_DATA_DIR = path.join(root, 'hub-data');
  process.env.FILESHUTTLE_WORKER_DIR = path.join(root, 'worker-state');
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FILESHUTTLE_SERVER_DATA_DIR;
  delete process.env.FILESHUTTLE_WORKER_DIR;
  delete process.env.FILESHUTTLE_SERVER_PORT;
  removeDir(root);
});

describe('workers CLI (on the hub)', () => {
  it('makes a one-time code, lists the computer as waiting, revokes and re-pairs it', async () => {
    expect(await runCli(['workers', 'pair', 'KVG', 'PC'])).toBe(0);
    const code = out[0];
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(err.join('\n')).toContain('expires at');

    out.length = 0;
    expect(await runCli(['workers', 'list'])).toBe(0);
    expect(out.join('\n')).toMatch(/KVG PC\twaiting for pairing/);
    expect(out.join('\n')).not.toContain(code);

    expect(await runCli(['workers', 'pair', 'kvg pc'])).toBe(1); // names are unique
    expect(await runCli(['workers', 'revoke', 'KVG PC'])).toBe(1); // not paired yet
    expect(await runCli(['workers', 'repair', 'KVG PC'])).toBe(1);
  });

  it('exits 2 on bad usage', async () => {
    expect(await runCli(['workers'])).toBe(2);
    expect(await runCli(['workers', 'pair'])).toBe(2);
    expect(await runCli(['workers', 'revoke'])).toBe(2);
    expect(await runCli(['workers', 'list', 'extra'])).toBe(2);
    expect(await runCli(['workers', 'frobnicate'])).toBe(2);
  });
});

describe('worker CLI (on the other computer)', () => {
  it('says it is not paired, and refuses to run without a pairing', async () => {
    expect(await runCli(['worker', 'status'])).toBe(0);
    expect(out.join('\n')).toMatch(/Not paired/);
    expect(await runCli(['worker'])).toBe(1);
    expect(err.join('\n')).toMatch(/not paired/);
    expect(await runCli(['worker', 'pair', 'only-one-argument'])).toBe(2);
    expect(await runCli(['worker', 'frobnicate'])).toBe(2);
  });

  it('refuses a hub address that is not https (a token goes there)', async () => {
    expect(await runCli(['worker', 'pair', 'http://holocron:8765', 'AAAAA-AAAAA'])).toBe(1);
    expect(err.join('\n')).toMatch(/https/);
  });

  it('pairs with a running hub, keeps the token in its own folder and never prints it', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as import('net').AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    process.env.FILESHUTTLE_SERVER_PORT = String(port);
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    process.env.FILESHUTTLE_SERVER_WEB_DIR = path.join(root, 'web');
    let hub: RunningServer | null = null;
    try {
      hub = await startServer('hub', parseServerConfig(), () => undefined);
      expect(await runCli(['workers', 'pair', 'KVG PC'])).toBe(0);
      const code = out[0];
      out.length = 0;
      err.length = 0;

      expect(await runCli(['worker', 'pair', `http://127.0.0.1:${port}`, code])).toBe(0);
      expect(out.join('\n')).toContain('Paired as "KVG PC"');
      const identityFile = path.join(root, 'worker-state', 'worker.json');
      const stored = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as { token: string };
      expect(stored.token).toMatch(/^fsw_/);
      expect(out.join('\n') + err.join('\n')).not.toContain(stored.token);

      // a code works once
      out.length = 0;
      expect(await runCli(['worker', 'pair', `http://127.0.0.1:${port}`, code])).toBe(1); // already paired here
      expect(await runCli(['worker', 'unpair'])).toBe(0);
      expect(fs.existsSync(identityFile)).toBe(false);
      expect(await runCli(['worker', 'pair', `http://127.0.0.1:${port}`, code])).toBe(1);
      expect(err.join('\n')).toMatch(/wrong, already used or expired/);

      // revoke on the hub from the command line
      expect(await runCli(['workers', 'revoke', 'KVG PC'])).toBe(0);
      out.length = 0;
      expect(await runCli(['workers', 'list'])).toBe(0);
      expect(out.join('\n')).toMatch(/KVG PC\tremote\tnot paired \(revoked\)/);
    } finally {
      delete process.env.FILESHUTTLE_SERVER_WEB_DIR;
      await hub?.stop();
    }
  });
});
