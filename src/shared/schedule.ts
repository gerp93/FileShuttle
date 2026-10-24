import type { CreateJobInput, ScheduleType } from './types';

/**
 * Schedule maths with no timers or Electron, so "was this job missed while the
 * app was closed or the PC asleep?" can be answered (and tested) from plain data.
 */

export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_INTERVAL_MINUTES = 60 * 24 * 365;
export const MAX_DAILY_TIMES = 24;

export function parseDailyTime(time: string | null): { hour: number; minute: number } | null {
  const match = time ? TIME_RE.exec(time.trim()) : null;
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** The latest HH:MM (local time) that is not in the future: today's if it has passed, else yesterday's. */
export function mostRecentDailyOccurrence(time: string, now: Date): Date | null {
  const parsed = parseDailyTime(time);
  if (!parsed) return null;
  const occurrence = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute, 0, 0);
  if (occurrence.getTime() > now.getTime()) occurrence.setDate(occurrence.getDate() - 1);
  return occurrence;
}

/** Trims, drops blanks and duplicates, and sorts HH:MM strings. Invalid entries are kept so validation can report them. */
export function normalizeDailyTimes(times: readonly string[]): string[] {
  return [...new Set(times.map((t) => t.trim()).filter(Boolean))].sort();
}

export interface ScheduledJobState {
  scheduleType: ScheduleType;
  scheduleIntervalMinutes: number | null;
  scheduleDailyTimes: string[];
  /** When the job last ran to completion (ISO), if ever. */
  lastRunAt: string | null;
  /** When the job was created (ISO); stands in for "last ran" if it never has. */
  createdAt: string;
}

/**
 * True when the schedule should have fired since the job last ran. Only
 * interval and daily jobs have a notion of "missed"; manual and watch jobs
 * never are.
 */
export function isJobOverdue(job: ScheduledJobState, now: Date): boolean {
  const baseline = Date.parse(job.lastRunAt ?? job.createdAt);
  if (Number.isNaN(baseline)) return false;

  if (job.scheduleType === 'interval') {
    if (!job.scheduleIntervalMinutes || job.scheduleIntervalMinutes < 1) return false;
    return now.getTime() - baseline >= job.scheduleIntervalMinutes * 60_000;
  }

  if (job.scheduleType === 'daily_at') {
    // Overdue if any of the set times has come and gone since the job last ran.
    return job.scheduleDailyTimes.some((time) => {
      const occurrence = mostRecentDailyOccurrence(time, now);
      return occurrence !== null && baseline < occurrence.getTime();
    });
  }

  return false;
}

/** Returns a problem with a job's name/steps/schedule, or null when it can be saved. */
export function validateJobInput(input: CreateJobInput): string | null {
  if (!input.name.trim()) return 'Job name is required.';
  if (!input.mappingIds.length) return 'Add at least one mapping. Jobs run mappings in order.';

  if (input.scheduleType === 'interval') {
    const minutes = input.scheduleIntervalMinutes;
    if (minutes == null || !Number.isInteger(minutes) || minutes < 1) {
      return 'The interval must be a whole number of minutes, at least 1.';
    }
    if (minutes > MAX_INTERVAL_MINUTES) return 'The interval can be at most one year.';
  } else if (input.scheduleType === 'daily_at') {
    const times = normalizeDailyTimes(input.scheduleDailyTimes);
    if (!times.length) return 'Add at least one time.';
    if (times.length > MAX_DAILY_TIMES) return `A job can run at most ${MAX_DAILY_TIMES} times a day.`;
    if (times.some((time) => !parseDailyTime(time))) return 'Times must be in HH:MM 24-hour format, e.g. 09:00.';
  }
  return null;
}
