import { Database } from 'sql.js';
import { computeRunStatus, JobRecord, RunResult } from '../../shared/types';
import * as repo from '../database/repository';
import { saveDatabase } from '../database/schema';
import { runMapping, undoRun } from '../engine/mover';

export function persistDb(db: Database): void {
  saveDatabase(db);
}

export async function executeJob(
  db: Database,
  jobId: number,
  triggerType: 'manual' | 'scheduled'
): Promise<RunResult> {
  const job = repo.getJob(db, jobId);
  if (!job) {
    throw new Error(`No job with id ${jobId}`);
  }
  const results = await runJobSteps(db, job, triggerType);
  persistDb(db);
  return aggregateResults(results);
}

async function runJobSteps(
  db: Database,
  job: JobRecord,
  triggerType: 'manual' | 'scheduled'
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let triggeredByRunId: number | null = null;

  for (const mapping of job.steps) {
    if (!mapping.enabled) continue;
    const result = await runMapping(repo.toMappingConfig(mapping));
    const status = computeRunStatus(result);
    const runId = repo.recordRun(db, {
      mappingId: mapping.id,
      mappingNameSnapshot: mapping.name,
      triggerType,
      result,
      status,
      triggeredByRunId,
      jobId: job.id,
      jobNameSnapshot: job.name,
    });
    results.push(result);
    triggeredByRunId = runId;
  }

  return results;
}

function aggregateResults(results: RunResult[]): RunResult {
  if (!results.length) {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      fileOutcomes: [],
      filesMoved: 0,
      filesCopied: 0,
      filesDeleted: 0,
      filesSkipped: 0,
      filesErrored: 0,
    };
  }
  return {
    startedAt: results[0].startedAt,
    finishedAt: results[results.length - 1].finishedAt,
    fileOutcomes: results.flatMap((r) => r.fileOutcomes),
    filesMoved: results.reduce((sum, r) => sum + r.filesMoved, 0),
    filesCopied: results.reduce((sum, r) => sum + r.filesCopied, 0),
    filesDeleted: results.reduce((sum, r) => sum + r.filesDeleted, 0),
    filesSkipped: results.reduce((sum, r) => sum + r.filesSkipped, 0),
    filesErrored: results.reduce((sum, r) => sum + r.filesErrored, 0),
  };
}

export function executeUndo(db: Database, runId: number): RunResult {
  const originalRun = repo.getRun(db, runId);
  if (!originalRun) {
    throw new Error(`No run with id ${runId}`);
  }

  const fileOutcomes = repo.getRunDetail(db, runId);
  const result = undoRun(fileOutcomes);
  const status = computeRunStatus(result);

  const undoRunId = repo.recordRun(db, {
    mappingId: originalRun.mappingId,
    mappingNameSnapshot: `Undo of “${baseMappingName(db, originalRun)}”`,
    triggerType: 'undo',
    result,
    status,
    jobId: originalRun.jobId,
    jobNameSnapshot: originalRun.jobNameSnapshot,
  });
  repo.markRunUndone(db, runId, undoRunId);
  persistDb(db);
  return result;
}

function baseMappingName(db: Database, run: { mappingId: number | null; mappingNameSnapshot: string }): string {
  if (run.mappingId == null) return run.mappingNameSnapshot;
  const record = repo.getMapping(db, run.mappingId);
  if (record) return record.name;
  const snapshot = run.mappingNameSnapshot;
  if (snapshot.startsWith('Undo of “') && snapshot.endsWith('”')) {
    return snapshot.slice('Undo of “'.length, -1);
  }
  return snapshot;
}

export async function executeAllEnabledJobs(
  db: Database,
  triggerType: 'manual' | 'scheduled'
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const job of repo.listJobs(db, true)) {
    results.push(await executeJob(db, job.id, triggerType));
  }
  return results;
}

