import { z } from 'zod';
import { Database } from '../database/sqlite';
import {
  ACTION_TYPES,
  CONFLICT_POLICIES,
  FILTER_FIELDS,
  FILTER_OPERATORS,
  MappingRecord,
  RunResult,
  SCHEDULE_TYPES,
  StepPreview,
} from '../../shared/types';
import * as repo from '../database/repository';
import { listWorkers } from '../database/workers';
import type { Hub } from '../hub/hub';
import { inputToConfig } from '../services/previewService';
import { JobAlreadyRunningError } from '../worker/runExecutor';
import {
  McpJobInput,
  McpMappingInput,
  checkJob,
  checkMapping,
  FOLDER_LIST_MAX_LIMIT,
  listFolder,
  saveJob,
  saveMapping,
  toMappingInput,
} from './actions';
import { ConfirmationStore } from './confirmations';

/** What the tools need from the app. Kept small so they can be tested without Electron or a real worker. */
export interface McpContext {
  getDb: () => Database;
  hub: Pick<
    Hub,
    'previewMapping' | 'previewJob' | 'checkFolder' | 'runJob' | 'cancelJob' | 'getActiveRuns' | 'connectedWorkerIds'
  >;
  /** Tell the scheduler/UI that mappings or jobs changed. */
  afterChange: () => void;
  /** How long run_job waits for a run to finish before answering "still running". Default 25 s. */
  runWaitMs?: number;
}

export type ToolOutput = { text: string; isError?: boolean };

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  run: (ctx: McpContext, args: any) => Promise<ToolOutput> | ToolOutput; // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * When the call as given would delete, move or replace files (or change a switched-on job so it does),
   * returns a plain description of exactly what would happen; otherwise null. Throws for a call that cannot
   * work at all (no such job), so no code is ever issued for it.
   */
  confirmation?: (ctx: McpContext, args: any) => Promise<string | null> | string | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const MAX_RESULT_CHARS = 24_000;

function ok(value: unknown): ToolOutput {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(cut: too long)` : text };
}

function fail(message: string): ToolOutput {
  return { text: message, isError: true };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const confirmField = z
  .string()
  .optional()
  .describe(
    'Only for the second call of a destructive action: the one-time code the first call returned, after the user agreed. Leave out the first time.'
  );

const mappingShape = {
  id: z
    .number()
    .int()
    .optional()
    .describe('Id of an existing mapping to update. Leave out to create a new mapping.'),
  name: z.string().describe('Short name, e.g. "Old downloads to archive".'),
  sourcePath: z.string().describe('Full path of the folder to take files from.'),
  destPath: z
    .string()
    .describe('Full path of the folder files go to. For a delete mapping there is no destination: pass "".'),
  recursive: z.boolean().describe('Include files in subfolders of the source.'),
  actionType: z.enum(ACTION_TYPES),
  conflictPolicy: z
    .enum(CONFLICT_POLICIES)
    .describe('What to do when a file with the same name is already at the destination.'),
  filters: z
    .array(
      z.object({
        field: z.enum(FILTER_FIELDS),
        operator: z.enum(FILTER_OPERATORS),
        value: z.string(),
        group: z
          .number()
          .int()
          .min(0)
          .describe(
            'Rules with the same group number are OR\'d; different groups are AND\'d. Use a separate group per condition unless you mean "either of these".'
          ),
      })
    )
    .describe('Which files to act on. Empty = every file in the source.'),
  keepNewest: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('Leave this many newest matching files in place and act on the rest. null = act on all matches.'),
  keepNewestPerExtension: z.boolean().describe('Apply keepNewest separately to each file extension.'),
};

const jobShape = {
  id: z.number().int().optional().describe('Id of an existing job to update. Leave out to create a new job.'),
  name: z.string(),
  scheduleType: z.enum(SCHEDULE_TYPES),
  scheduleIntervalMinutes: z.number().int().min(1).nullable().describe('Only for scheduleType "interval".'),
  scheduleDailyTimes: z
    .array(z.string())
    .describe('HH:MM, 24-hour, local time. Only for scheduleType "daily_at"; otherwise [].'),
  catchUp: z.boolean().describe('Run once at start-up/wake if a scheduled run was missed.'),
  mappingIds: z.array(z.number().int()).describe('Existing mapping ids, in the order the job runs them.'),
};

/** Counts and a few rows, so a preview is readable without sending thousands of file names. */
function summarizePreview(preview: StepPreview) {
  const { result } = preview;
  return {
    mapping: preview.mappingName,
    action: preview.actionType,
    wouldMove: result.filesMoved,
    wouldCopy: result.filesCopied,
    wouldDelete: result.filesDeleted,
    wouldZip: result.filesZipped,
    wouldExtract: result.filesExtracted,
    wouldSkip: result.filesSkipped,
    wouldError: result.filesErrored,
    totalMegabytes: Math.round((preview.totalBytes / 1_048_576) * 10) / 10,
    wouldReplaceExistingFiles: preview.overwriteCount,
    sampleFiles: result.fileOutcomes.slice(0, 25).map((f) => ({
      file: f.sourcePath,
      outcome: f.outcome,
      reason: f.reason,
      sizeBytes: f.sizeBytes,
    })),
    moreFiles: Math.max(0, preview.totalOutcomes - 25),
  };
}


// --- Which saved things can delete, move or replace files -------------------------------------

/** Why a step is destructive, or null when it only copies, zips or unzips into a place with no overwrite. */
export function destructiveReason(step: { actionType: string; conflictPolicy: string }): string | null {
  if (step.actionType === 'delete') return 'DELETES the matching files';
  if (step.actionType === 'move') return 'MOVES the matching files out of the source folder';
  if (step.conflictPolicy === 'overwrite') return 'REPLACES files that already exist at the destination';
  return null;
}

function describeSteps(steps: MappingRecord[]): { lines: string[]; destructive: boolean } {
  const lines: string[] = [];
  let destructive = false;
  steps.forEach((step, i) => {
    if (!step.enabled) return;
    const reason = destructiveReason(step);
    if (reason) destructive = true;
    lines.push(
      `${i + 1}. "${step.name}": ${step.actionType} from ${step.sourcePath}` +
        (step.actionType === 'delete' ? '' : ` to ${step.destPath}`) +
        (reason ? ` (${reason})` : '')
    );
  });
  return { lines, destructive };
}

function requireJob(db: Database, id: number) {
  const job = repo.getJob(db, id);
  if (!job) throw new Error(`There is no job with id ${id}.`);
  return job;
}

function summarizeRun(job: string, result: RunResult) {
  return {
    job,
    finished: true,
    cancelled: result.cancelled === true,
    moved: result.filesMoved,
    copied: result.filesCopied,
    deleted: result.filesDeleted,
    zipped: result.filesZipped,
    extracted: result.filesExtracted,
    skipped: result.filesSkipped,
    errored: result.filesErrored,
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_workers',
    description:
      'List the machines that move files (workers): id, name, kind, app version, whether connected to the hub right now, and when last seen.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx) =>
      ok(
        listWorkers(ctx.getDb()).map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind,
          appVersion: w.appVersion,
          online: ctx.hub.connectedWorkerIds().includes(w.id),
          lastSeenAt: w.lastSeenAt,
        }))
      ),
  },
  {
    name: 'list_mappings',
    description:
      'List every saved mapping (a "step": one move/copy/delete/zip/unzip rule with filters) and which jobs use it.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx) => {
      const db = ctx.getDb();
      return ok(
        repo.listMappings(db).map((m) => ({
          id: m.id,
          name: m.name,
          workerId: m.workerId,
          action: m.actionType,
          sourcePath: m.sourcePath,
          destPath: m.destPath,
          recursive: m.recursive,
          conflictPolicy: m.conflictPolicy,
          filters: m.filters,
          keepNewest: m.keepNewest,
          keepNewestPerExtension: m.keepNewestPerExtension,
          switchedOn: m.enabled,
          usedByJobs: repo.listJobsUsingMapping(db, m.id).map((j) => j.name),
        }))
      );
    },
  },
  {
    name: 'list_jobs',
    description:
      'List every saved job: its schedule, whether it is switched on, when it last ran, and its steps in order.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx) =>
      ok(
        repo.listJobs(ctx.getDb()).map((j) => ({
          id: j.id,
          name: j.name,
          workerId: j.workerId,
          switchedOn: j.enabled,
          scheduleType: j.scheduleType,
          scheduleIntervalMinutes: j.scheduleIntervalMinutes,
          scheduleDailyTimes: j.scheduleDailyTimes,
          catchUp: j.catchUp,
          lastRunAt: j.lastRunAt,
          steps: j.steps.map((s) => ({ mappingId: s.id, name: s.name, action: s.actionType, switchedOn: s.enabled })),
        }))
      ),
  },
  {
    name: 'get_active_runs',
    description: 'Jobs that are queued or running right now, with their progress.',
    schema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx) => ok(ctx.hub.getActiveRuns()),
  },
  {
    name: 'get_run_history',
    description:
      'Recent runs (newest first), optionally for one job or mapping: when, status, and how many files were moved/skipped/errored.',
    schema: z.object({
      jobId: z.number().int().optional(),
      mappingId: z.number().int().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx, { jobId, mappingId, limit }) =>
      ok(repo.listRuns(ctx.getDb(), { jobId: jobId ?? null, mappingId: mappingId ?? null }).slice(0, limit ?? 15)),
  },
  {
    name: 'get_run_files',
    description: 'Per-file results of one past run (file path, outcome, reason, size). Paths and sizes only.',
    schema: z.object({ runId: z.number().int(), limit: z.number().int().min(1).max(200).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx, { runId, limit }) => {
      const files = repo.getRunDetail(ctx.getDb(), runId);
      return ok({ total: files.length, files: files.slice(0, limit ?? 50) });
    },
  },
  {
    name: 'check_folder',
    description:
      'Does this folder path work? role "source" must already exist; a "destination" may not exist yet (it is created on the first run).',
    schema: z.object({ path: z.string(), role: z.enum(['source', 'destination']) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { path: folder, role }) => {
      try {
        return ok(await ctx.hub.checkFolder(folder, role));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'list_folder',
    description: `Look inside a folder: names, sizes and modified dates only (never file contents), plus counts per extension. Shallow by default; recursive goes up to 3 levels. At most ${FOLDER_LIST_MAX_LIMIT} entries.`,
    schema: z.object({
      path: z.string(),
      recursive: z.boolean().optional(),
      limit: z.number().int().min(1).max(FOLDER_LIST_MAX_LIMIT).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (_ctx, { path: folder, recursive, limit }) => {
      try {
        return ok(await listFolder(folder, { recursive, limit }));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'validate_mapping',
    description:
      'Check a mapping without saving it: errors that would block saving, and warnings (missing folders, destructive settings). Run this before save_mapping.',
    schema: z.object({ mapping: z.object(mappingShape) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { mapping }) => ok(await checkMapping(ctx.getDb(), mapping as McpMappingInput)),
  },
  {
    name: 'validate_job',
    description:
      'Check a job without saving it: errors that would block saving, and warnings. Run this before save_job.',
    schema: z.object({ job: z.object(jobShape) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ctx, { job }) => ok(checkJob(ctx.getDb(), job as McpJobInput)),
  },
  {
    name: 'preview_mapping',
    description:
      'Dry-run a mapping (saved by id, or a draft you pass in) against the folders as they are right now. NOTHING is changed on disk. Shows how many files it would move/copy/delete/zip/extract/skip and a sample of file names.',
    schema: z.object({ mappingId: z.number().int().optional(), mapping: z.object(mappingShape).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { mappingId, mapping }) => {
      const db = ctx.getDb();
      try {
        if (mappingId != null) {
          const record = repo.getMapping(db, mappingId);
          if (!record) return fail(`No mapping with id ${mappingId}.`);
          return ok(summarizePreview(await ctx.hub.previewMapping(repo.toMappingConfig(record), record.workerId)));
        }
        if (!mapping) return fail('Pass mappingId or a mapping.');
        const check = await checkMapping(db, mapping as McpMappingInput);
        if (check.errors.length) return fail(`Fix these first: ${check.errors.join(' ')}`);
        const config = inputToConfig(toMappingInput(db, mapping as McpMappingInput));
        return ok(summarizePreview(await ctx.hub.previewMapping(config)));
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'preview_job',
    description:
      "Dry-run every switched-on step of a saved job, in order. NOTHING is changed on disk. Later steps are previewed against the folders as they are now, so a step that consumes an earlier step's output looks emptier than it will on a real run.",
    schema: z.object({ jobId: z.number().int() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { jobId }) => {
      try {
        const preview = await ctx.hub.previewJob(jobId);
        return ok({ job: preview.jobName, steps: preview.steps.map(summarizePreview) });
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'save_mapping',
    description:
      'Create or update a mapping. A mapping on its own never runs; it only runs as a step of a job. If the change makes a mapping that a switched-on job uses delete, move or overwrite files, the user must confirm first.',
    schema: z.object({ mapping: z.object(mappingShape), confirm: confirmField }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    confirmation: async (ctx, { mapping }) => {
      const db = ctx.getDb();
      const input = mapping as McpMappingInput;
      if (input.id == null) return null;
      const reason = destructiveReason(input);
      if (!reason) return null;
      if ((await checkMapping(db, input)).errors.length) return null;
      const live = repo
        .listJobsUsingMapping(db, input.id)
        .map((ref) => repo.getJob(db, ref.id))
        .filter((j) => j?.enabled);
      if (live.length === 0) return null;
      return (
        `Save mapping "${input.name}" (id ${input.id}) as ${input.actionType} from ${input.sourcePath}` +
        (input.actionType === 'delete' ? '' : ` to ${input.destPath}`) +
        `. It ${reason}, and it is a step of the switched-on job(s): ${live.map((j) => `"${j!.name}"`).join(', ')}, ` +
        'so the next run of those jobs will do that.'
      );
    },
    run: async (ctx, { mapping }) => {
      try {
        const db = ctx.getDb();
        const check = await checkMapping(db, mapping as McpMappingInput);
        if (check.errors.length) return fail(`Not saved. ${check.errors.join(' ')}`);
        const id = saveMapping(db, mapping as McpMappingInput);
        ctx.afterChange();
        return ok({ saved: true, mappingId: id, warnings: check.warnings });
      } catch (e) {
        return fail(`Not saved. ${errorText(e)}`);
      }
    },
  },
  {
    name: 'save_job',
    description:
      'Create or update a job. A NEW job is always saved switched off; an existing job keeps its on/off state (use set_job_enabled to change it). If the saved job would be switched on and has a step that deletes, moves or overwrites files, the user must confirm first.',
    schema: z.object({ job: z.object(jobShape), confirm: confirmField }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    confirmation: (ctx, { job }) => {
      const db = ctx.getDb();
      const input = job as McpJobInput;
      if (input.id == null) return null;
      const existing = repo.getJob(db, input.id);
      if (!existing?.enabled) return null;
      if (checkJob(db, input).errors.length) return null;
      const steps = input.mappingIds.map((id) => repo.getMapping(db, id)).filter((m): m is MappingRecord => !!m);
      const { lines, destructive } = describeSteps(steps);
      if (!destructive) return null;
      return (
        `Save job "${input.name}" (id ${input.id}), which is switched ON, with these steps:\n${lines.join('\n')}\n` +
        'The next run will do this.'
      );
    },
    run: (ctx, { job }) => {
      try {
        const db = ctx.getDb();
        const check = checkJob(db, job as McpJobInput);
        if (check.errors.length) return fail(`Not saved. ${check.errors.join(' ')}`);
        const id = saveJob(db, job as McpJobInput);
        ctx.afterChange();
        const saved = repo.getJob(db, id);
        return ok({ saved: true, jobId: id, switchedOn: saved?.enabled ?? false, warnings: check.warnings });
      } catch (e) {
        return fail(`Not saved. ${errorText(e)}`);
      }
    },
  },
  {
    name: 'set_job_enabled',
    description:
      'Switch a job on or off. A job that is on runs on its schedule (or when files appear, for a watch job). Switching on a job that deletes, moves or overwrites files needs the user\'s confirmation.',
    schema: z.object({ jobId: z.number().int(), enabled: z.boolean(), confirm: confirmField }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    confirmation: (ctx, { jobId, enabled }) => {
      const job = requireJob(ctx.getDb(), jobId);
      if (!enabled) return null;
      const { lines, destructive } = describeSteps(job.steps);
      if (!destructive) return null;
      return `Switch ON job "${job.name}" (id ${job.id}, schedule: ${job.scheduleType}). It will then run by itself and do this:\n${lines.join('\n')}`;
    },
    run: (ctx, { jobId, enabled }) => {
      try {
        const job = requireJob(ctx.getDb(), jobId);
        repo.setJobEnabled(ctx.getDb(), jobId, enabled);
        ctx.afterChange();
        return ok({ jobId, name: job.name, switchedOn: enabled });
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'run_job',
    description:
      'Run a job now. If a step deletes, moves or overwrites files, the user must confirm first. Waits up to about 25 seconds for the result; a longer run keeps going (see get_active_runs and get_run_history).',
    schema: z.object({ jobId: z.number().int(), confirm: confirmField }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    confirmation: (ctx, { jobId }) => {
      const job = requireJob(ctx.getDb(), jobId);
      const { lines, destructive } = describeSteps(job.steps);
      if (!destructive) return null;
      return `Run job "${job.name}" (id ${job.id}) right now. It will do this:\n${lines.join('\n')}`;
    },
    run: async (ctx, { jobId }) => {
      let job;
      try {
        job = requireJob(ctx.getDb(), jobId);
      } catch (e) {
        return fail(errorText(e));
      }
      const run = ctx.hub.runJob(jobId, 'manual');
      const settled = run.then(
        (result) => ({ result }) as const,
        (error: unknown) => ({ error }) as const
      );
      const waitMs = ctx.runWaitMs ?? 25_000;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), waitMs);
      });
      const outcome = await Promise.race([settled, timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'pending') {
        return ok({ job: job.name, started: true, finished: false, note: 'Still running. See get_active_runs and get_run_history.' });
      }
      if ('error' in outcome) {
        if (outcome.error instanceof JobAlreadyRunningError) return fail(`Job "${job.name}" is already running.`);
        return fail(errorText(outcome.error));
      }
      return ok(summarizeRun(job.name, outcome.result));
    },
  },
  {
    name: 'cancel_run',
    description: 'Ask a queued or running job to stop before its next file. Work already done is kept.',
    schema: z.object({ jobId: z.number().int() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (ctx, { jobId }) => {
      try {
        const cancelled = await ctx.hub.cancelJob(jobId);
        return ok(cancelled ? { jobId, cancelRequested: true } : { jobId, cancelRequested: false, note: 'That job is not running.' });
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'delete_job',
    description:
      'Permanently delete a job and its schedule. Its steps (mappings) are kept, and past runs stay in History. The user must confirm first.',
    schema: z.object({ jobId: z.number().int(), confirm: confirmField }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    confirmation: (ctx, { jobId }) => {
      const job = requireJob(ctx.getDb(), jobId);
      return `Permanently delete job "${job.name}" (id ${job.id}, ${job.enabled ? 'switched on' : 'switched off'}, schedule: ${job.scheduleType}, ${job.steps.length} step(s)). Its mappings are kept.`;
    },
    run: (ctx, { jobId }) => {
      try {
        const job = requireJob(ctx.getDb(), jobId);
        repo.deleteJob(ctx.getDb(), jobId);
        ctx.afterChange();
        return ok({ deleted: true, jobId, name: job.name });
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
  {
    name: 'delete_mapping',
    description:
      'Permanently delete a mapping. Refused while a job still uses it. The user must confirm first.',
    schema: z.object({ mappingId: z.number().int(), confirm: confirmField }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    confirmation: (ctx, { mappingId }) => {
      const db = ctx.getDb();
      const mapping = repo.getMapping(db, mappingId);
      if (!mapping) throw new Error(`There is no mapping with id ${mappingId}.`);
      const jobs = repo.listJobsUsingMapping(db, mappingId);
      if (jobs.length) {
        throw new Error(`Mapping "${mapping.name}" is still used by: ${jobs.map((j) => j.name).join(', ')}. Remove it from those jobs first.`);
      }
      return `Permanently delete mapping "${mapping.name}" (id ${mapping.id}: ${mapping.actionType} from ${mapping.sourcePath}).`;
    },
    run: (ctx, { mappingId }) => {
      try {
        repo.deleteMapping(ctx.getDb(), mappingId);
        ctx.afterChange();
        return ok({ deleted: true, mappingId });
      } catch (e) {
        return fail(errorText(e));
      }
    },
  },
];

export const READ_ONLY_TOOL_NAMES = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
export const CONFIRMATION_TOOL_NAMES = TOOLS.filter((t) => t.confirmation).map((t) => t.name);

/** The MCP `tools/list` entry for a tool: JSON Schema made from the same zod schema that checks the call. */
export function toolListing(tool: ToolDef) {
  const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, inputSchema: schema, annotations: tool.annotations };
}

export type CallOutcome = 'ok' | 'error' | 'needs-confirmation';

export interface CallResult {
  output: ToolOutput;
  outcome: CallOutcome;
}

/** Wording of the first answer of a destructive call. It states plainly that nothing has happened yet. */
function confirmationText(tool: string, description: string, code: string, minutes: number): string {
  return [
    'CONFIRMATION REQUIRED. Nothing has been done yet.',
    '',
    description,
    '',
    'Ask the user to confirm this exact action before calling again with confirm.',
    `If they agree, call ${tool} again with exactly the same arguments plus confirm: "${code}". The code works once and expires in ${minutes} minutes.`,
  ].join('\n');
}

/**
 * Runs one tool call: checks the arguments, applies the confirmation rule for destructive actions,
 * and never throws (every failure is a plain sentence the model can read).
 */
export async function callTool(
  ctx: McpContext,
  confirmations: ConfirmationStore,
  tokenName: string,
  name: string,
  rawArgs: unknown
): Promise<CallResult | { invalidParams: string }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { invalidParams: `Unknown tool "${name}".` };
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
    return { invalidParams: `Invalid arguments for ${name}: ${detail}` };
  }
  const args = parsed.data as Record<string, unknown>;
  try {
    if (tool.confirmation) {
      const description = await tool.confirmation(ctx, args);
      if (description) {
        const code = typeof args.confirm === 'string' ? args.confirm : '';
        if (!code) {
          const { code: issued, expiresInMinutes } = confirmations.issue(tokenName, name, args);
          return { output: { text: confirmationText(name, description, issued, expiresInMinutes) }, outcome: 'needs-confirmation' };
        }
        const verdict = confirmations.consume(tokenName, name, args, code);
        if (verdict !== 'ok') {
          const why =
            verdict === 'expired'
              ? 'That confirmation code has expired.'
              : verdict === 'wrong'
                ? 'That confirmation code is wrong.'
                : 'There is no pending confirmation for exactly these arguments (the code may be used up or the arguments changed).';
          return {
            output: fail(`${why} Nothing was done. Call ${name} again without confirm to get a new code, and ask the user to confirm.`),
            outcome: 'error',
          };
        }
      }
    }
    const output = await tool.run(ctx, args);
    return { output, outcome: output.isError ? 'error' : 'ok' };
  } catch (e) {
    return { output: fail(errorText(e)), outcome: 'error' };
  }
}
