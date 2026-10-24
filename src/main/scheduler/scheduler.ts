import cron from 'node-cron';
import { Database } from 'sql.js';
import { isJobOverdue } from '../../shared/schedule';
import { JobRecord } from '../../shared/types';
import * as repo from '../database/repository';
import { executeJob, JobAlreadyRunningError } from '../services/runService';

type ScheduledRunCallback = (jobId: number, result: import('../../shared/types').RunResult) => void;

interface ScheduledJob {
  intervalId?: NodeJS.Timeout;
  cronTasks?: cron.ScheduledTask[];
}

export class SchedulerService {
  private jobs = new Map<number, ScheduledJob>();
  private onScheduledRunComplete?: ScheduledRunCallback;

  constructor(
    private db: Database,
    onScheduledRunComplete?: ScheduledRunCallback
  ) {
    this.onScheduledRunComplete = onScheduledRunComplete;
  }

  start(): void {
    this.reloadJobs();
  }

  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.intervalId) clearInterval(job.intervalId);
      job.cronTasks?.forEach((task) => task.stop());
    }
    this.jobs.clear();
  }

  reloadJobs(): void {
    this.shutdown();
    for (const record of repo.listJobs(this.db, true)) {
      if (record.scheduleType === 'manual') continue;
      const job = this.buildJob(record);
      if (job) this.jobs.set(record.id, job);
    }
  }

  /**
   * Runs, once, every job that opted in to catching up and whose schedule
   * fired while the app wasn't running (closed, or the PC asleep). Safe to
   * call repeatedly: a job that has since run is no longer overdue, and one
   * that is still running is skipped.
   */
  catchUp(now: Date = new Date()): number {
    let started = 0;
    for (const record of repo.listJobs(this.db, true)) {
      if (record.catchUp && isJobOverdue(record, now)) {
        this.runScheduled(record.id);
        started += 1;
      }
    }
    return started;
  }

  private buildJob(record: JobRecord): ScheduledJob | null {
    if (record.scheduleType === 'interval') {
      if (!record.scheduleIntervalMinutes) return null;
      const intervalMs = record.scheduleIntervalMinutes * 60 * 1000;
      const intervalId = setInterval(() => this.runScheduled(record.id), intervalMs);
      return { intervalId };
    }

    if (record.scheduleType === 'daily_at') {
      const cronTasks = record.scheduleDailyTimes.flatMap((time) => {
        const [hour, minute] = time.split(':').map((v) => parseInt(v, 10));
        return Number.isNaN(hour) || Number.isNaN(minute)
          ? []
          : [cron.schedule(`${minute} ${hour} * * *`, () => this.runScheduled(record.id))];
      });
      return cronTasks.length ? { cronTasks } : null;
    }

    return null;
  }

  private runScheduled(jobId: number): void {
    void (async () => {
      try {
        const result = await executeJob(this.db, jobId, 'scheduled');
        this.onScheduledRunComplete?.(jobId, result);
      } catch (err) {
        if (err instanceof JobAlreadyRunningError) {
          // The previous run is still going (long job, short interval). Skip
          // this tick; the next one will pick up whatever is left.
          console.warn(`Skipping scheduled run for job_id=${jobId}: still running from an earlier trigger`);
          return;
        }
        console.error(`Scheduled run failed for job_id=${jobId}`, err);
      }
    })();
  }
}
