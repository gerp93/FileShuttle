import { z } from 'zod';
import { Database } from 'sql.js';
import {
  ACTION_TYPES,
  CONFLICT_POLICIES,
  FILTER_FIELDS,
  FILTER_OPERATORS,
  SCHEDULE_TYPES,
} from '../../shared/types';
import * as repo from '../database/repository';
import { checkFolder } from '../folderCheck';
import { inputToConfig, previewJob, previewMapping } from '../services/previewService';
import {
  AssistantJobInput,
  AssistantMappingInput,
  checkJob,
  checkMapping,
  FOLDER_LIST_MAX_LIMIT,
  listFolder,
  saveJob,
  saveMapping,
  toMappingInput,
} from './actions';
import type { AgentSdk } from './sdk';

export const SERVER_NAME = 'fileshuttle';

const prefixed = (name: string) => `mcp__${SERVER_NAME}__${name}`;

/** Tools that only look at things: no approval needed. */
export const READ_ONLY_TOOLS = [
  'list_mappings',
  'list_jobs',
  'get_run_history',
  'get_run_files',
  'check_folder',
  'list_folder',
  'validate_mapping',
  'validate_job',
  'preview_mapping',
  'preview_job',
].map(prefixed);

/** Tools that change what is saved. Each one waits for the user's OK. */
export const SAVE_MAPPING = prefixed('save_mapping');
export const SAVE_JOB = prefixed('save_job');
export const WRITE_TOOLS = [SAVE_MAPPING, SAVE_JOB];

/** What the tools need from the app. Kept small so the tools can be tested without Electron. */
export interface AgentContext {
  getDb: () => Database;
  /** Persist and tell the scheduler/UI that mappings or jobs changed. */
  afterChange: () => void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const MAX_RESULT_CHARS = 24_000;

function ok(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [
      {
        type: 'text',
        text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(cut: too long)` : text,
      },
    ],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
function summarizePreview(preview: Awaited<ReturnType<typeof previewMapping>>) {
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

/** The FileShuttle tools, hosted in-process so they call app code directly. */
export function createFileShuttleServer(sdk: AgentSdk, ctx: AgentContext) {
  const { tool, createSdkMcpServer } = sdk;
  const readOnly = { annotations: { readOnlyHint: true } };
  const db = () => ctx.getDb();

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'list_mappings',
        'List every saved mapping (a "step": one move/copy/delete/zip/unzip rule with filters) and which jobs use it.',
        {},
        async () =>
          ok(
            repo.listMappings(db()).map((m) => ({
              id: m.id,
              name: m.name,
              action: m.actionType,
              sourcePath: m.sourcePath,
              destPath: m.destPath,
              recursive: m.recursive,
              conflictPolicy: m.conflictPolicy,
              filters: m.filters,
              keepNewest: m.keepNewest,
              keepNewestPerExtension: m.keepNewestPerExtension,
              switchedOn: m.enabled,
              usedByJobs: repo.listJobsUsingMapping(db(), m.id).map((j) => j.name),
            }))
          ),
        readOnly
      ),
      tool(
        'list_jobs',
        'List every saved job: its schedule, whether it is switched on, when it last ran, and its steps in order.',
        {},
        async () =>
          ok(
            repo.listJobs(db()).map((j) => ({
              id: j.id,
              name: j.name,
              switchedOn: j.enabled,
              scheduleType: j.scheduleType,
              scheduleIntervalMinutes: j.scheduleIntervalMinutes,
              scheduleDailyTimes: j.scheduleDailyTimes,
              catchUp: j.catchUp,
              lastRunAt: j.lastRunAt,
              steps: j.steps.map((s) => ({ mappingId: s.id, name: s.name, action: s.actionType })),
            }))
          ),
        readOnly
      ),
      tool(
        'get_run_history',
        'Recent runs (newest first), optionally for one job or mapping: when, status, and how many files were moved/skipped/errored.',
        {
          jobId: z.number().int().optional(),
          mappingId: z.number().int().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        },
        async ({ jobId, mappingId, limit }) =>
          ok(repo.listRuns(db(), { jobId: jobId ?? null, mappingId: mappingId ?? null }).slice(0, limit ?? 15)),
        readOnly
      ),
      tool(
        'get_run_files',
        'Per-file results of one past run (file path, outcome, reason, size). Paths and sizes only.',
        { runId: z.number().int(), limit: z.number().int().min(1).max(200).optional() },
        async ({ runId, limit }) => {
          const files = repo.getRunDetail(db(), runId);
          return ok({ total: files.length, files: files.slice(0, limit ?? 50) });
        },
        readOnly
      ),
      tool(
        'check_folder',
        'Does this folder path work? role "source" must already exist; a "destination" may not exist yet (it is created on the first run).',
        { path: z.string(), role: z.enum(['source', 'destination']) },
        async ({ path: folder, role }) => ok(await checkFolder(folder, role)),
        readOnly
      ),
      tool(
        'list_folder',
        `Look inside a folder: names, sizes and modified dates only (never file contents), plus counts per extension. Shallow by default; recursive goes up to 3 levels. At most ${FOLDER_LIST_MAX_LIMIT} entries.`,
        {
          path: z.string(),
          recursive: z.boolean().optional(),
          limit: z.number().int().min(1).max(FOLDER_LIST_MAX_LIMIT).optional(),
        },
        async ({ path: folder, recursive, limit }) => {
          try {
            return ok(await listFolder(folder, { recursive, limit }));
          } catch (e) {
            return fail(errorText(e));
          }
        },
        readOnly
      ),
      tool(
        'validate_mapping',
        'Check a mapping without saving it: errors that would block saving, and warnings (missing folders, destructive settings). Always run this before save_mapping.',
        { mapping: z.object(mappingShape) },
        async ({ mapping }) => ok(await checkMapping(db(), mapping as AssistantMappingInput)),
        readOnly
      ),
      tool(
        'validate_job',
        'Check a job without saving it: errors that would block saving, and warnings. Always run this before save_job.',
        { job: z.object(jobShape) },
        async ({ job }) => ok(checkJob(db(), job as AssistantJobInput)),
        readOnly
      ),
      tool(
        'preview_mapping',
        'Dry-run a mapping (saved by id, or a draft you pass in) against the folders as they are right now. NOTHING is changed on disk. Shows how many files it would move/copy/delete/zip/extract/skip and a sample of file names.',
        { mappingId: z.number().int().optional(), mapping: z.object(mappingShape).optional() },
        async ({ mappingId, mapping }) => {
          try {
            if (mappingId != null) {
              const record = repo.getMapping(db(), mappingId);
              if (!record) return fail(`No mapping with id ${mappingId}.`);
              return ok(
                summarizePreview(
                  await previewMapping(repo.toMappingConfig(record), { unzipLimits: repo.getUnzipLimits(db()) })
                )
              );
            }
            if (!mapping) return fail('Pass mappingId or a mapping.');
            const check = await checkMapping(db(), mapping as AssistantMappingInput);
            if (check.errors.length) return fail(`Fix these first: ${check.errors.join(' ')}`);
            const config = inputToConfig(toMappingInput(db(), mapping as AssistantMappingInput));
            return ok(summarizePreview(await previewMapping(config, { unzipLimits: repo.getUnzipLimits(db()) })));
          } catch (e) {
            return fail(errorText(e));
          }
        },
        readOnly
      ),
      tool(
        'preview_job',
        'Dry-run every switched-on step of a saved job, in order. NOTHING is changed on disk. Later steps are previewed against the folders as they are now, so a step that consumes an earlier step\'s output looks emptier than it will on a real run.',
        { jobId: z.number().int() },
        async ({ jobId }) => {
          try {
            const preview = await previewJob(db(), jobId);
            return ok({ job: preview.jobName, steps: preview.steps.map(summarizePreview) });
          } catch (e) {
            return fail(errorText(e));
          }
        },
        readOnly
      ),
      tool(
        'save_mapping',
        'Create or update a mapping. The user reviews and approves it before it is saved. A mapping on its own never runs; it only runs as a step of a job.',
        { mapping: z.object(mappingShape) },
        async ({ mapping }) => {
          try {
            const check = await checkMapping(db(), mapping as AssistantMappingInput);
            if (check.errors.length) return fail(`Not saved. ${check.errors.join(' ')}`);
            const id = saveMapping(db(), mapping as AssistantMappingInput);
            ctx.afterChange();
            return ok({ saved: true, mappingId: id, warnings: check.warnings });
          } catch (e) {
            return fail(`Not saved. ${errorText(e)}`);
          }
        }
      ),
      tool(
        'save_job',
        'Create or update a job. The user reviews and approves it before it is saved. The job is ALWAYS saved switched off: the user turns it on themselves after reviewing it. You cannot run, enable, or delete a job.',
        { job: z.object(jobShape) },
        async ({ job }) => {
          try {
            const check = checkJob(db(), job as AssistantJobInput);
            if (check.errors.length) return fail(`Not saved. ${check.errors.join(' ')}`);
            const id = saveJob(db(), job as AssistantJobInput);
            ctx.afterChange();
            return ok({ saved: true, jobId: id, switchedOn: false, warnings: check.warnings });
          } catch (e) {
            return fail(`Not saved. ${errorText(e)}`);
          }
        }
      ),
    ],
  });
}
