import type { JobRecord, RunResult } from '../../shared/types';

/**
 * What the scheduler and the folder watcher need from the worker around them: the jobs it was
 * given (never the database) and a way to run one.
 */
export interface JobSource {
  listEnabledJobs(): JobRecord[];
  runJob(jobId: number, trigger: 'manual' | 'scheduled'): Promise<RunResult>;
}
