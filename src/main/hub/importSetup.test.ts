import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import type { Database } from '../database/sqlite';
import { getLocalWorkerId, getScheduleVersion } from '../database/workers';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { Hub } from './hub';
import { createPairingCode } from './pairing';
import { WorkerGateway } from './workerGateway';
import { importSetup, parseSetupPayload, SetupPayload } from './importSetup';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;
let gateway: WorkerGateway;
let workerId: string;
let token: string;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-import-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  gateway = new WorkerGateway({ getDb: () => db, hub: new Hub({ getDb: () => db }) });
  const paired = gateway.pair({ code: createPairingCode(db).code, name: 'Laptop', platform: 'win32' }).body as { workerId: string; token: string };
  workerId = paired.workerId;
  token = paired.token;
});
afterEach(() => {
  db.close();
  removeDir(root);
});

const mapping = (sourceId: number, name: string, extra: Record<string, unknown> = {}) => ({
  sourceId, nextSourceId: null, name, sourcePath: 'C:\\In', destPath: 'D:\\Out', recursive: false, conflictPolicy: 'skip', enabled: true,
  scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTime: null, filters: [], actionType: 'copy', keepNewest: null,
  keepNewestPerExtension: false, ...extra,
});
const job = (name: string, steps: number[]) => ({
  name, catchUp: false, scheduleType: 'interval', scheduleIntervalMinutes: 30, scheduleDailyTimes: [], stepSourceIds: steps,
});

function payload(input: unknown): SetupPayload {
  const parsed = parseSetupPayload(input);
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

describe('importSetup', () => {
  it('puts mappings and jobs on the sending machine, re-points chains and steps, and saves jobs switched off', () => {
    const before = getScheduleVersion(db, workerId);
    const report = importSetup(
      db,
      workerId,
      payload({ mappings: [mapping(7, 'First', { nextSourceId: 8 }), mapping(8, 'Second')], jobs: [job('Nightly', [7, 8])] })
    );
    expect(report).toMatchObject({ ok: true, mappingsSent: 2, jobsSent: 1, mappingsSkipped: [], jobsSkipped: [] });
    const mappings = repo.listMappings(db, false, workerId);
    expect(mappings.map((m) => m.name).sort()).toEqual(['First', 'Second']);
    const first = mappings.find((m) => m.name === 'First')!;
    const second = mappings.find((m) => m.name === 'Second')!;
    expect(first.nextMappingId).toBe(second.id);
    const jobs = repo.listJobs(db, false, workerId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].enabled).toBe(false);
    expect(jobs[0].steps.map((s) => s.name)).toEqual(['First', 'Second']);
    expect(getScheduleVersion(db, workerId)).toBeGreaterThan(before);
    // Nothing leaked onto the hub's own machine.
    expect(repo.listMappings(db, false, getLocalWorkerId(db))).toHaveLength(0);
  });

  it('skips a name the machine already has (and the job that needed it), and reports it', () => {
    importSetup(db, workerId, payload({ mappings: [mapping(1, 'Photos')], jobs: [job('Backup', [1])] }));
    const report = importSetup(
      db,
      workerId,
      payload({ mappings: [mapping(1, 'photos'), mapping(2, 'Music')], jobs: [job('Backup', [2]), job('Tunes', [2]), job('Pics', [1])] })
    );
    expect(report.mappingsSent).toBe(1);
    expect(report.mappingsSkipped.map((s) => s.name)).toEqual(['photos']);
    expect(report.jobsSent).toBe(1);
    expect(report.jobsSkipped.map((s) => s.name).sort()).toEqual(['Backup', 'Pics']);
    expect(repo.listMappings(db, false, workerId)).toHaveLength(2);
    expect(repo.listJobs(db, false, workerId).map((j) => j.name).sort()).toEqual(['Backup', 'Tunes']);
  });

  it('leaves out an invalid mapping with its reason, and rejects a malformed payload', () => {
    const report = importSetup(db, workerId, payload({ mappings: [mapping(1, 'No source', { sourcePath: ' ' })], jobs: [] }));
    expect(report.mappingsSkipped[0].reason).toMatch(/source/i);
    expect(typeof parseSetupPayload({ mappings: [{ name: 5 }], jobs: [] })).toBe('string');
    expect(typeof parseSetupPayload({ mappings: [mapping(1, 'x', { actionType: 'format' })], jobs: [] })).toBe('string');
    expect(typeof parseSetupPayload('nope')).toBe('string');
  });
});

describe('the gateway door', () => {
  it('needs the machine\'s own token', () => {
    const body = { mappings: [mapping(1, 'A')], jobs: [] };
    expect(gateway.importSetup(workerId, 'fsw_wrong', body).status).toBe(401);
    expect(gateway.importSetup('other-id', token, body).status).toBe(401);
    expect(gateway.importSetup(workerId, '', body).status).toBe(401);
    expect(repo.listMappings(db, false, workerId)).toHaveLength(0);
    const ok = gateway.importSetup(workerId, token, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mappingsSent: 1 });
    expect(gateway.importSetup(workerId, token, { nonsense: true }).status).toBe(400);
  });
});
