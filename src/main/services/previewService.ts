import { Database } from 'sql.js';
import {
  CreateMappingInput,
  FileOutcome,
  JobPreview,
  MappingConfig,
  PREVIEW_OUTCOME_LIMIT,
  StepPreview,
} from '../../shared/types';
import * as repo from '../database/repository';
import { runMapping, UnzipLimits } from '../engine/mover';

const ACTIONABLE: ReadonlySet<FileOutcome['outcome']> = new Set(['moved', 'copied', 'deleted', 'zipped', 'extracted']);

/** Dry-runs one mapping: nothing on disk changes and nothing is written to run history. */
export async function previewMapping(config: MappingConfig, options: { unzipLimits?: UnzipLimits } = {}): Promise<StepPreview> {
  const result = await runMapping(config, { dryRun: true, unzipLimits: options.unzipLimits });
  const totalOutcomes = result.fileOutcomes.length;
  const totalBytes = result.fileOutcomes.reduce(
    (sum, file) => (ACTIONABLE.has(file.outcome) ? sum + (file.sizeBytes ?? 0) : sum),
    0
  );
  const overwriteCount = result.fileOutcomes.filter(
    (file) => ACTIONABLE.has(file.outcome) && file.reason === 'conflict_overwrite'
  ).length;
  const truncated = totalOutcomes > PREVIEW_OUTCOME_LIMIT;
  return {
    mappingId: config.id,
    mappingName: config.name,
    actionType: config.actionType,
    result: truncated ? { ...result, fileOutcomes: result.fileOutcomes.slice(0, PREVIEW_OUTCOME_LIMIT) } : result,
    totalOutcomes,
    truncated,
    totalBytes,
    overwriteCount,
  };
}

/** Builds a runnable config from an editor form that hasn't been saved yet. */
export function inputToConfig(input: CreateMappingInput, id = 0): MappingConfig {
  return {
    id,
    name: input.name,
    sourcePath: input.sourcePath,
    destPath: input.destPath,
    recursive: input.recursive,
    conflictPolicy: input.conflictPolicy,
    filters: input.filters,
    actionType: input.actionType,
    keepNewest: input.keepNewest,
  };
}

/**
 * Previews every enabled step against the folders as they are right now.
 * Steps after the first are shown the same way, so a step that consumes the
 * output of an earlier step will look emptier here than it will on a real run.
 */
export async function previewJob(db: Database, jobId: number): Promise<JobPreview> {
  const job = repo.getJob(db, jobId);
  if (!job) throw new Error(`No job with id ${jobId}`);
  const steps: StepPreview[] = [];
  for (const mapping of job.steps) {
    if (!mapping.enabled) continue;
    steps.push(await previewMapping(repo.toMappingConfig(mapping), { unzipLimits: repo.getUnzipLimits(db) }));
  }
  return { jobId: job.id, jobName: job.name, steps };
}
