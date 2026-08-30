import cron from 'node-cron';
import { Database } from 'sql.js';
import { MappingRecord } from '../../shared/types';
import * as repo from '../database/repository';
import { executeMapping } from '../services/runService';

type ScheduledRunCallback = (mappingId: number, result: import('../../shared/types').RunResult) => void;

interface ScheduledJob {
  intervalId?: NodeJS.Timeout;
  cronTask?: cron.ScheduledTask;
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
      if (job.cronTask) job.cronTask.stop();
    }
    this.jobs.clear();
  }

  reloadJobs(): void {
    this.shutdown();
    for (const record of repo.listMappings(this.db, true)) {
      if (record.scheduleType === 'manual') continue;
      const job = this.buildJob(record);
      if (job) this.jobs.set(record.id, job);
    }
  }

  runNow(mappingId: number): void {
    setImmediate(async () => {
      try {
        await executeMapping(this.db, mappingId, 'manual');
      } catch (err) {
        console.error(`Run failed for mapping_id=${mappingId}`, err);
      }
    });
  }

  private buildJob(record: MappingRecord): ScheduledJob | null {
    if (record.scheduleType === 'interval') {
      if (!record.scheduleIntervalMinutes) return null;
      const intervalMs = record.scheduleIntervalMinutes * 60 * 1000;
      const intervalId = setInterval(() => this.runScheduled(record.id), intervalMs);
      return { intervalId };
    }

    if (record.scheduleType === 'daily_at') {
      if (!record.scheduleDailyTime) return null;
      const [hour, minute] = record.scheduleDailyTime.split(':').map((v) => parseInt(v, 10));
      const cronTask = cron.schedule(`${minute} ${hour} * * *`, () => this.runScheduled(record.id));
      return { cronTask };
    }

    return null;
  }

  private runScheduled(mappingId: number): void {
    void (async () => {
      try {
        const result = await executeMapping(this.db, mappingId, 'scheduled');
        this.onScheduledRunComplete?.(mappingId, result);
      } catch (err) {
        console.error(`Scheduled run failed for mapping_id=${mappingId}`, err);
      }
    })();
  }
}
