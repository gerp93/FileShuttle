import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HUB_TO_WORKER_TYPES,
  PROTOCOL_VERSION,
  ProtocolMessage,
  WORKER_OFFLINE_AFTER_MS,
  WORKER_TO_HUB_TYPES,
} from './workerProtocol';
import type { JobRecord, MappingRecord, RunProgressEvent, RunResult } from './types';

const mapping: MappingRecord = {
  id: 1,
  workerId: 'w1',
  name: 'm',
  sourcePath: '/in',
  destPath: '/out',
  recursive: false,
  actionType: 'move',
  conflictPolicy: 'skip',
  filters: [{ field: 'extension', operator: 'equals', value: 'pdf', group: 0 }],
  filterMatchMode: 'all',
  keepNewest: null,
  keepNewestPerExtension: false,
  enabled: true,
  scheduleType: 'manual',
  scheduleIntervalMinutes: null,
  scheduleDailyTime: null,
  nextMappingId: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as MappingRecord;

const job: JobRecord = {
  id: 2,
  workerId: 'w1',
  name: 'j',
  enabled: true,
  catchUp: false,
  lastRunAt: null,
  scheduleType: 'interval',
  scheduleIntervalMinutes: 5,
  scheduleDailyTimes: [],
  steps: [mapping],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
} as unknown as JobRecord;

const result: RunResult = {
  startedAt: '2024-01-01T00:00:00.000Z',
  finishedAt: '2024-01-01T00:00:01.000Z',
  fileOutcomes: [{ sourcePath: '/in/a', destPath: '/out/a', outcome: 'moved', reason: null, sizeBytes: 3 }],
  filesMoved: 1,
  filesCopied: 0,
  filesDeleted: 0,
  filesSkipped: 0,
  filesErrored: 0,
  filesExtracted: 0,
  filesZipped: 0,
};

const event: RunProgressEvent = {
  jobId: 2,
  jobName: 'j',
  phase: 'processing',
  stepIndex: 1,
  stepCount: 1,
  stepName: 'm',
  scanned: 4,
  processed: 2,
  total: 4,
};

// One example of every message. Typing it as a Record makes a new message type a compile error here.
const examples: Record<ProtocolMessage['type'], ProtocolMessage> = {
  hello: { type: 'hello', workerId: 'w1', token: 't', appVersion: '1.2.3', protocolVersion: PROTOCOL_VERSION, scheduleVersion: 4 },
  scheduleAck: { type: 'scheduleAck', workerId: 'w1', version: 4 },
  commandResult: { type: 'commandResult', requestId: 'r1', ok: true, payload: result },
  runStarted: { type: 'runStarted', workerId: 'w1', runUid: 'u1', jobId: 2, mappingId: 1, startedAt: result.startedAt },
  progress: { type: 'progress', workerId: 'w1', event },
  runFinished: {
    type: 'runFinished',
    workerId: 'w1',
    runUid: 'u1',
    mappingId: 1,
    mappingNameSnapshot: 'm',
    jobId: 2,
    jobNameSnapshot: 'j',
    triggerType: 'scheduled',
    status: 'success',
    errorMessage: null,
    triggeredByRunUid: null,
    undoesRunUid: null,
    result,
  },
  jobFinished: { type: 'jobFinished', workerId: 'w1', jobId: 2, startedAt: result.startedAt, completed: true },
  log: { type: 'log', workerId: 'w1', level: 'warn', message: 'hello' },
  heartbeat: { type: 'heartbeat', workerId: 'w1', sentAt: result.startedAt },
  schedule: { type: 'schedule', version: 4, schedule: { mappings: [mapping], jobs: [job] } },
  runNow: { type: 'runNow', requestId: 'r1', jobId: 2, trigger: 'manual' },
  cancel: { type: 'cancel', requestId: 'r2', jobId: 2 },
  preview: {
    type: 'preview',
    requestId: 'r3',
    configs: [{ ...mapping } as never],
  },
  undo: {
    type: 'undo',
    requestId: 'r4',
    originalRunUid: 'u1',
    mappingId: 1,
    mappingNameSnapshot: 'Undo of “m”',
    jobId: 2,
    jobNameSnapshot: 'j',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    originalWasUndo: false,
    fileOutcomes: result.fileOutcomes,
  },
  listFolder: { type: 'listFolder', requestId: 'r5', folder: null },
  checkFolder: { type: 'checkFolder', requestId: 'r6', folder: '/in', role: 'source' },
};

describe('worker protocol', () => {
  it('has a version and heartbeat constants', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(WORKER_OFFLINE_AFTER_MS).toBe(90_000);
  });

  it('lists every message type once, in one direction or the other', () => {
    const listed = [...WORKER_TO_HUB_TYPES, ...HUB_TO_WORKER_TYPES];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(examples).sort());
  });

  it.each(Object.entries(examples))('%s survives a JSON round trip unchanged', (_type, message) => {
    const copy = JSON.parse(JSON.stringify(message));
    expect(copy).toEqual(message);
    // Nothing that JSON would silently drop: every key present, no undefined values.
    expect(JSON.stringify(copy)).toBe(JSON.stringify(message));
    const hasUndefined = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === 'object' && value !== null && Object.values(value).some(hasUndefined));
    expect(hasUndefined(message)).toBe(false);
  });

  it('gives every command a requestId and every result the same one back', () => {
    for (const type of ['runNow', 'cancel', 'preview', 'undo', 'listFolder', 'checkFolder'] as const) {
      expect((examples[type] as { requestId: string }).requestId).toMatch(/^r\d$/);
    }
    expect((examples.commandResult as { requestId: string }).requestId).toBe('r1');
  });
});
