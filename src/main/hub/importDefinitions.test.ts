import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { getLocalWorkerId } from '../database/workers';
import { createPairingCode, redeemPairingCode } from './pairing';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { ImportError, importDefinitions } from './importDefinitions';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let pc: Database;
let hubDb: Database;
let workerId: string;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-import-');
  pc = await initDatabase(path.join(root, 'pc.db'));
  hubDb = await initDatabase(path.join(root, 'hub.db'));
  const paired = redeemPairingCode(hubDb, createPairingCode(hubDb).code, { name: 'PC', platform: 'win32' });
  if (!paired.ok) throw new Error('pairing failed in the test setup');
  workerId = paired.worker.id;
});
afterEach(() => {
  pc.close();
  hubDb.close();
  removeDir(root);
});

const base = (name: string, extra: Partial<Parameters<typeof repo.createMapping>[1]> = {}): Parameters<typeof repo.createMapping>[1] => ({
  name, sourcePath: `C:\\in\\${name}`, destPath: `C:\\out\\${name}`, recursive: true, conflictPolicy: 'auto_rename', enabled: true,
  scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null,
  filters: [{ field: 'extension', operator: 'equals', value: 'zip', group: 0 }], nextMappingId: null, actionType: 'move',
  keepNewest: 3, keepNewestPerExtension: true, ...extra,
});

function pcData() {
  const a = repo.createMapping(pc, base('a'));
  const b = repo.createMapping(pc, base('b', { nextMappingId: a }));
  const job = repo.createJob(pc, {
    name: 'nightly', enabled: true, catchUp: true, scheduleType: 'daily_at', scheduleIntervalMinutes: null,
    scheduleDailyTimes: ['02:00', '14:30'], mappingIds: [b, a],
  });
  repo.setJobLastRun(pc, job, '2026-11-27T02:00:00.000Z');
  repo.createJob(pc, {
    name: 'watching', enabled: false, scheduleType: 'watch', scheduleIntervalMinutes: null, scheduleDailyTimes: [], mappingIds: [a],
  });
  return { mappings: repo.listMappings(pc), jobs: repo.listJobs(pc) };
}

describe('importDefinitions', () => {
  it('creates every mapping and job on the machine, with new ids, steps in order, filters and the last run kept', () => {
    const before = getLocalWorkerId(hubDb);
    const result = importDefinitions(hubDb, workerId, pcData());
    expect(result).toEqual({ mappings: 2, jobs: 2 });

    const mappings = repo.listMappings(hubDb, false, workerId);
    const jobs = repo.listJobs(hubDb, false, workerId);
    expect(mappings.map((m) => m.name).sort()).toEqual(['a', 'b']);
    expect(mappings.every((m) => m.workerId === workerId && m.workerId !== before)).toBe(true);
    const [a, b] = ['a', 'b'].map((n) => mappings.find((m) => m.name === n)!);
    expect(b.nextMappingId).toBe(a.id); // the chain follows the new ids
    expect(a).toMatchObject({ keepNewest: 3, keepNewestPerExtension: true, recursive: true, conflictPolicy: 'auto_rename' });
    expect(a.filters).toEqual([{ field: 'extension', operator: 'equals', value: 'zip', group: 0 }]);

    const nightly = jobs.find((j) => j.name === 'nightly')!;
    expect(nightly).toMatchObject({ enabled: true, catchUp: true, scheduleDailyTimes: ['02:00', '14:30'], lastRunAt: '2026-11-27T02:00:00.000Z' });
    expect(nightly.steps.map((s) => s.name)).toEqual(['b', 'a']);
    expect(jobs.find((j) => j.name === 'watching')).toMatchObject({ enabled: false, scheduleType: 'watch' });
    // Nothing landed on the hub's own machine.
    expect(repo.listMappings(hubDb, false, before)).toEqual([]);
    expect(repo.listJobs(hubDb, false, before)).toEqual([]);
  });

  it('can switch the jobs off', () => {
    importDefinitions(hubDb, workerId, { ...pcData(), switchOff: true });
    expect(repo.listJobs(hubDb, false, workerId).map((j) => j.enabled)).toEqual([false, false]);
  });

  it('refuses a second import and a machine that already has definitions, creating nothing more', () => {
    importDefinitions(hubDb, workerId, pcData());
    expect(() => importDefinitions(hubDb, workerId, pcData())).toThrow(/already has 2 mapping/);
    expect(repo.listMappings(hubDb, false, workerId)).toHaveLength(2);
  });

  it('is all or nothing: one bad mapping, or a job that uses a mapping that was not sent, imports nothing', () => {
    const good = pcData();
    const bad = { ...good, mappings: good.mappings.map((m, i) => (i === 1 ? { ...m, sourcePath: '' } : m)) };
    expect(() => importDefinitions(hubDb, workerId, bad)).toThrow(ImportError);
    expect(() => importDefinitions(hubDb, workerId, { ...good, mappings: good.mappings.slice(1) })).toThrow(/not sent/);
    expect(repo.listMappings(hubDb, false, workerId)).toEqual([]);
    expect(repo.listJobs(hubDb, false, workerId)).toEqual([]);
  });

  it('refuses nonsense and oversized input', () => {
    expect(() => importDefinitions(hubDb, workerId, null as never)).toThrow(ImportError);
    expect(() => importDefinitions(hubDb, workerId, { mappings: 'x', jobs: [] } as never)).toThrow(ImportError);
  });
});
