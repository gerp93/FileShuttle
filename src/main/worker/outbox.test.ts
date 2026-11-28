import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerToHub } from '../../shared/workerProtocol';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { Outbox } from './outbox';
import { WorkerStateStore } from './workerState';

let root: string;
beforeEach(() => {
  root = makeTempDir('fileshuttle-outbox-');
});
afterEach(() => removeDir(root));

const log = (n: number): WorkerToHub => ({ type: 'log', workerId: 'w', level: 'info', message: `m${n}` });

describe('Outbox', () => {
  it('keeps reports in order, across a restart, until they are acknowledged', () => {
    const file = path.join(root, 'outbox.jsonl');
    const box = new Outbox(file);
    box.append(log(1));
    const second = box.append(log(2));
    box.append(log(3));

    const reopened = new Outbox(file);
    expect(reopened.peek(10).map((e) => (e.message as { message: string }).message)).toEqual(['m1', 'm2', 'm3']);

    reopened.ackThrough(second);
    expect(new Outbox(file).peek(10).map((e) => (e.message as { message: string }).message)).toEqual(['m3']);
    // sequence numbers keep counting up after a restart
    const next = new Outbox(file).append(log(4));
    expect(next).toBeGreaterThan(second + 1);
  });

  it('skips a line torn by a crash and keeps the rest', () => {
    const file = path.join(root, 'outbox.jsonl');
    const box = new Outbox(file);
    box.append(log(1));
    fs.appendFileSync(file, '{"seq":2,"message":{"type":"lo');
    expect(new Outbox(file).peek(10)).toHaveLength(1);
  });

  it('drops the oldest reports beyond its limit and says how many', () => {
    const dropped: number[] = [];
    const box = new Outbox(path.join(root, 'outbox.jsonl'), { maxEntries: 3, onDropped: (n) => dropped.push(n) });
    for (let i = 1; i <= 5; i++) box.append(log(i));
    expect(box.size).toBe(3);
    expect(box.peek(10).map((e) => (e.message as { message: string }).message)).toEqual(['m3', 'm4', 'm5']);
    expect(dropped.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('WorkerStateStore', () => {
  const identity = { hubUrl: 'https://hub.example.ts.net', workerId: 'w1', name: 'KVG PC', token: 'fsw_secret-token' };

  it('stores the identity, and the token only readable by its owner on a POSIX system', () => {
    const store = new WorkerStateStore(path.join(root, 'worker'));
    expect(store.loadIdentity()).toBeNull();
    store.saveIdentity(identity);
    expect(store.loadIdentity()).toEqual(identity);
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.identityFile).mode & 0o777).toBe(0o600);
    }
  });

  it('can encrypt the token with the platform store, and never writes it in the clear then', () => {
    const protection = {
      encrypt: (plain: string) => Buffer.from(plain.split('').reverse().join('')).toString('base64'),
      decrypt: (stored: string) => Buffer.from(stored, 'base64').toString().split('').reverse().join(''),
    };
    const store = new WorkerStateStore(path.join(root, 'worker'), protection);
    store.saveIdentity(identity);
    expect(fs.readFileSync(store.identityFile, 'utf8')).not.toContain('fsw_secret-token');
    expect(store.loadIdentity()).toEqual(identity);
    // without the platform store the token cannot be read back (and is not guessed)
    expect(new WorkerStateStore(store.dir).loadIdentity()).toBeNull();
  });

  it('forgets everything on clear()', () => {
    const store = new WorkerStateStore(path.join(root, 'worker'));
    store.saveIdentity(identity);
    store.saveSchedule({ version: 3, schedule: { mappings: [], jobs: [] } });
    new Outbox(store.outboxFile).append(log(1));
    store.clear();
    expect(store.loadIdentity()).toBeNull();
    expect(store.loadSchedule()).toBeNull();
    expect(fs.existsSync(store.outboxFile)).toBe(false);
  });
});
