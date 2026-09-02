import { FSWatcher, watch } from 'chokidar';
import { Database } from 'sql.js';
import { JobRecord } from '../../shared/types';
import * as repo from '../database/repository';
import { executeJob } from '../services/runService';

type WatchedRunCallback = (jobId: number, result: import('../../shared/types').RunResult) => void;

/** New files trigger via OS filesystem events (inotify/FSEvents/ReadDirectoryChangesW) — no polling loop. */
const DEBOUNCE_MS = 1500;
const STABILITY_THRESHOLD_MS = 2000;

export class WatcherService {
  private watchers = new Map<number, FSWatcher>();
  private debounceTimers = new Map<number, NodeJS.Timeout>();
  private onWatchedRunComplete?: WatchedRunCallback;

  constructor(
    private db: Database,
    onWatchedRunComplete?: WatchedRunCallback
  ) {
    this.onWatchedRunComplete = onWatchedRunComplete;
  }

  start(): void {
    this.reloadJobs();
  }

  shutdown(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      void watcher.close();
    }
    this.watchers.clear();
  }

  reloadJobs(): void {
    this.shutdown();
    for (const job of repo.listJobs(this.db, true)) {
      if (job.scheduleType !== 'watch') continue;
      const watcher = this.buildWatcher(job);
      if (watcher) this.watchers.set(job.id, watcher);
    }
  }

  private buildWatcher(job: JobRecord): FSWatcher | null {
    const firstStep = job.steps.find((step) => step.enabled);
    if (!firstStep) return null;

    const watcher = watch(firstStep.sourcePath, {
      ignoreInitial: true,
      depth: firstStep.recursive ? undefined : 0,
      awaitWriteFinish: { stabilityThreshold: STABILITY_THRESHOLD_MS, pollInterval: 200 },
    });

    const trigger = () => this.scheduleRun(job.id);
    watcher.on('add', trigger);
    watcher.on('addDir', trigger);
    watcher.on('error', (err) => console.error(`Watcher error for job_id=${job.id}`, err));

    return watcher;
  }

  private scheduleRun(jobId: number): void {
    const existing = this.debounceTimers.get(jobId);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      jobId,
      setTimeout(() => {
        this.debounceTimers.delete(jobId);
        this.runWatched(jobId);
      }, DEBOUNCE_MS)
    );
  }

  private runWatched(jobId: number): void {
    void (async () => {
      try {
        const result = await executeJob(this.db, jobId, 'scheduled');
        this.onWatchedRunComplete?.(jobId, result);
      } catch (err) {
        console.error(`Watched run failed for job_id=${jobId}`, err);
      }
    })();
  }
}
