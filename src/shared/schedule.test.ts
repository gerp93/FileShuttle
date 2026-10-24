import { describe, expect, it } from 'vitest';
import {
  isJobOverdue,
  MAX_DAILY_TIMES,
  mostRecentDailyOccurrence,
  normalizeDailyTimes,
  parseDailyTime,
  ScheduledJobState,
  validateJobInput,
} from './schedule';
import type { CreateJobInput } from './types';
import { isJobOutputPath, watchTargets, WatchStep } from './watchTargets';

// Local-time constructors keep these tests timezone-independent.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const iso = (d: Date) => d.toISOString();

describe('parseDailyTime', () => {
  it('parses valid HH:MM and rejects the rest', () => {
    expect(parseDailyTime('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseDailyTime('23:59')).toEqual({ hour: 23, minute: 59 });
    for (const bad of ['9:05', '24:00', '12:60', 'noon', '', null]) expect(parseDailyTime(bad)).toBeNull();
  });
});

describe('mostRecentDailyOccurrence', () => {
  it("is today's time once it has passed", () => {
    expect(mostRecentDailyOccurrence('09:00', local(2026, 3, 10, 14, 30))).toEqual(local(2026, 3, 10, 9, 0));
  });

  it("is yesterday's time while today's is still ahead", () => {
    expect(mostRecentDailyOccurrence('09:00', local(2026, 3, 10, 8, 0))).toEqual(local(2026, 3, 9, 9, 0));
  });

  it('counts the exact minute as already happened', () => {
    expect(mostRecentDailyOccurrence('09:00', local(2026, 3, 10, 9, 0))).toEqual(local(2026, 3, 10, 9, 0));
  });

  it('crosses month boundaries', () => {
    expect(mostRecentDailyOccurrence('09:00', local(2026, 3, 1, 8, 0))).toEqual(local(2026, 2, 28, 9, 0));
  });
});

describe('isJobOverdue', () => {
  const base: ScheduledJobState = {
    scheduleType: 'interval',
    scheduleIntervalMinutes: 60,
    scheduleDailyTimes: [],
    lastRunAt: null,
    createdAt: iso(local(2026, 3, 10, 8, 0)),
  };

  it('interval: overdue once a full interval has elapsed since the last run', () => {
    const job = { ...base, lastRunAt: iso(local(2026, 3, 10, 8, 0)) };
    expect(isJobOverdue(job, local(2026, 3, 10, 8, 59))).toBe(false);
    expect(isJobOverdue(job, local(2026, 3, 10, 9, 0))).toBe(true);
    expect(isJobOverdue(job, local(2026, 3, 11, 9, 0))).toBe(true);
  });

  it('interval: a job that never ran counts from when it was created', () => {
    expect(isJobOverdue(base, local(2026, 3, 10, 8, 30))).toBe(false);
    expect(isJobOverdue(base, local(2026, 3, 10, 9, 30))).toBe(true);
  });

  it('daily: overdue when the most recent occurrence is after the last run', () => {
    const job: ScheduledJobState = {
      ...base,
      scheduleType: 'daily_at',
      scheduleIntervalMinutes: null,
      scheduleDailyTimes: ['09:00'],
      lastRunAt: iso(local(2026, 3, 9, 9, 0)), // ran yesterday at 09:00
    };
    expect(isJobOverdue(job, local(2026, 3, 10, 8, 59))).toBe(false); // today's run not due yet
    expect(isJobOverdue(job, local(2026, 3, 10, 9, 1))).toBe(true); // missed today's
    expect(isJobOverdue(job, local(2026, 3, 12, 6, 0))).toBe(true); // missed several days
  });

  it('daily: not overdue after it already ran for the latest occurrence', () => {
    const job: ScheduledJobState = {
      ...base,
      scheduleType: 'daily_at',
      scheduleIntervalMinutes: null,
      scheduleDailyTimes: ['09:00'],
      lastRunAt: iso(local(2026, 3, 10, 9, 0)),
    };
    expect(isJobOverdue(job, local(2026, 3, 10, 17, 0))).toBe(false);
  });

  it('daily with several times: overdue when any set time has passed since the last run', () => {
    const job: ScheduledJobState = {
      ...base,
      scheduleType: 'daily_at',
      scheduleIntervalMinutes: null,
      scheduleDailyTimes: ['09:00', '17:00'],
      lastRunAt: iso(local(2026, 3, 10, 9, 0)), // ran this morning
    };
    expect(isJobOverdue(job, local(2026, 3, 10, 16, 59))).toBe(false); // evening run not due yet
    expect(isJobOverdue(job, local(2026, 3, 10, 17, 1))).toBe(true); // missed the evening run
    expect(isJobOverdue({ ...job, lastRunAt: iso(local(2026, 3, 10, 17, 0)) }, local(2026, 3, 10, 23, 0))).toBe(false);
  });

  it('manual and watch jobs are never overdue', () => {
    for (const scheduleType of ['manual', 'watch'] as const) {
      expect(isJobOverdue({ ...base, scheduleType }, local(2030, 1, 1))).toBe(false);
    }
  });

  it('ignores an unusable schedule or timestamp', () => {
    expect(isJobOverdue({ ...base, scheduleIntervalMinutes: 0 }, local(2030, 1, 1))).toBe(false);
    expect(isJobOverdue({ ...base, createdAt: 'garbage' }, local(2030, 1, 1))).toBe(false);
    expect(isJobOverdue({ ...base, scheduleType: 'daily_at', scheduleDailyTimes: [] }, local(2030, 1, 1))).toBe(false);
  });
});

describe('validateJobInput', () => {
  const ok: CreateJobInput = {
    name: 'j',
    enabled: true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTimes: [],
    mappingIds: [1],
  };

  it('accepts valid jobs', () => {
    expect(validateJobInput(ok)).toBeNull();
    expect(validateJobInput({ ...ok, scheduleType: 'interval', scheduleIntervalMinutes: 15 })).toBeNull();
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: ['07:30', '18:00'] })).toBeNull();
  });

  it('requires a name and at least one mapping', () => {
    expect(validateJobInput({ ...ok, name: '  ' })).toMatch(/name is required/);
    expect(validateJobInput({ ...ok, mappingIds: [] })).toMatch(/at least one mapping/);
  });

  it('rejects intervals that are zero, negative, fractional, missing, or absurd', () => {
    for (const minutes of [0, -5, 1.5, null, 10 ** 9]) {
      expect(validateJobInput({ ...ok, scheduleType: 'interval', scheduleIntervalMinutes: minutes })).toBeTruthy();
    }
  });

  it('rejects a malformed daily time, even among valid ones', () => {
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: ['9am'] })).toMatch(/HH:MM/);
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: ['09:00', '25:00'] })).toMatch(/HH:MM/);
  });

  it('requires at least one daily time and caps how many', () => {
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: [] })).toMatch(/at least one time/);
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: ['', '  '] })).toMatch(/at least one time/);
    const tooMany = Array.from({ length: MAX_DAILY_TIMES + 1 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: tooMany })).toMatch(/at most/);
  });

  it('treats repeated times as one', () => {
    expect(validateJobInput({ ...ok, scheduleType: 'daily_at', scheduleDailyTimes: ['09:00', ' 09:00'] })).toBeNull();
  });
});

describe('watchTargets', () => {
  const step = (overrides: Partial<WatchStep>): WatchStep => ({
    enabled: true,
    actionType: 'move',
    sourcePath: 'C:\\in',
    destPath: 'C:\\out',
    recursive: false,
    ...overrides,
  });

  it('watches the source of every enabled step, not just the first', () => {
    const targets = watchTargets([step({ sourcePath: 'C:\\a', destPath: 'C:\\x' }), step({ sourcePath: 'C:\\b', destPath: 'C:\\y' })]);
    expect(targets.map((t) => t.path)).toEqual(['C:\\a', 'C:\\b']);
  });

  it('skips disabled steps', () => {
    const targets = watchTargets([step({}), step({ enabled: false, sourcePath: 'C:\\off' })]);
    expect(targets.map((t) => t.path)).toEqual(['C:\\in']);
  });

  it("does not watch a folder the job itself writes into (a later step's source)", () => {
    const targets = watchTargets([
      step({ sourcePath: 'C:\\in', destPath: 'C:\\staging' }),
      step({ sourcePath: 'c:/STAGING/', destPath: 'C:\\final' }),
    ]);
    expect(targets.map((t) => t.path)).toEqual(['C:\\in']);
  });

  it('merges steps that share a source, recursive if any of them is', () => {
    const targets = watchTargets([
      step({ destPath: 'C:\\o1', recursive: false }),
      step({ destPath: 'C:\\o2', recursive: true }),
    ]);
    expect(targets).toEqual([{ path: 'C:\\in', recursive: true }]);
  });

  it('a delete step has no output folder to exclude', () => {
    const targets = watchTargets([step({ actionType: 'delete', destPath: 'C:\\in' })]);
    expect(targets.map((t) => t.path)).toEqual(['C:\\in']);
  });
});

describe('isJobOutputPath', () => {
  const steps: WatchStep[] = [
    { enabled: true, actionType: 'move', sourcePath: 'C:\\in', destPath: 'C:\\in\\done', recursive: true },
  ];

  it('recognises files inside a destination as the job’s own output', () => {
    expect(isJobOutputPath('C:\\in\\done\\a.txt', steps)).toBe(true);
    expect(isJobOutputPath('c:/in/DONE/sub/b.txt', steps)).toBe(true);
  });

  it('treats everything else as input', () => {
    expect(isJobOutputPath('C:\\in\\a.txt', steps)).toBe(false);
    expect(isJobOutputPath('C:\\in\\donut\\a.txt', steps)).toBe(false);
  });
});

describe('normalizeDailyTimes', () => {
  it('trims, drops blanks and duplicates, and sorts', () => {
    expect(normalizeDailyTimes([' 17:00', '09:00', '', '17:00'])).toEqual(['09:00', '17:00']);
  });
});
