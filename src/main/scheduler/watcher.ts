import { FSWatcher, watch } from 'chokidar';
import { Database } from 'sql.js';
import { JobRecord } from '../../shared/types';
import { isJobOutputPath, watchTargets, WatchStep } from '../../shared/watchTargets';
import * as repo from '../database/repository';
import { executeJob, JobAlreadyRunningError } from '../services/runService';

type WatchedRunCallback = (jobId: number, result: import('../../shared/types').RunResult) => void;

/** New files trigger via OS filesystem events (inotify/FSEvents/ReadDirectoryChangesW) — no polling loop. */
const DEBOUNCE_MS = 1500;
const STABILITY_THRESHOLD_MS = 2000;

function toWatchSteps(job: JobRecord): WatchStep[] {
  return job.steps.map((step) => ({
    enabled: step.enabled,
    actionType: step.actionType,
    sourcePath: step.sourcePath,
    destPath: step.destPath,
    recursive: step.recursive,
  }));
}

/**
 * Watching a job means: when a file shows up in the source folder of any of its
 * mappings, run the WHOLE job (every mapping, in order) -- not just the new
 * file. Folders the job writes into are never watched, so its own output can't
 * trigger it again.
 */
export class WatcherService {
  private watchers = new Map<number, FSWatcher[]>();
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
    for (const group of this.watchers.values()) {
      for (const watcher of group) void watcher.close();
    }
    this.watchers.clear();
  }

  reloadJobs(): void {
    this.shutdown();
    for (const job of repo.listJobs(this.db, true)) {
      if (job.scheduleType !== 'watch') continue;
      const group = this.buildWatchers(job);
      if (group.length) this.watchers.set(job.id, group);
    }
  }

  /**
   * Files may have arrived while the app wasn't running (or the PC was
   * asleep) -- nothing was there to notice them. For jobs that opted in to
   * catching up, run once now to pick them up.
   */
  catchUp(): number {
    let started = 0;
    for (const job of repo.listJobs(this.db, true)) {
      if (job.scheduleType === 'watch' && job.catchUp) {
        this.scheduleRun(job.id);
        started += 1;
      }
    }
    return started;
  }

  private buildWatchers(job: JobRecord): FSWatcher[] {
    const steps = toWatchSteps(job);
    return watchTargets(steps).map((target) => {
      const watcher = watch(target.path, {
        ignoreInitial: true,
        depth: target.recursive ? undefined : 0,
        awaitWriteFinish: { stabilityThreshold: STABILITY_THRESHOLD_MS, pollInterval: 200 },
        // A recursive watch can see into a folder the job writes to.
        ignored: (candidate: string) => isJobOutputPath(candidate, steps),
      });

      const trigger = () => this.scheduleRun(job.id);
      watcher.on('add', trigger);
      watcher.on('addDir', trigger);
      watcher.on('error', (err) => console.error(`Watcher error for job_id=${job.id}`, err));
      return watcher;
    });
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
        if (err instanceof JobAlreadyRunningError) {
          // Files landed while the job was mid-run. Try again shortly so they
          // aren't left waiting for the next unrelated file event.
          this.scheduleRun(jobId);
          return;
        }
        console.error(`Watched run failed for job_id=${jobId}`, err);
      }
    })();
  }
}
