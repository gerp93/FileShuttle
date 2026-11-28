import * as path from 'path';
import { Database } from '../database/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { getLocalWorkerId } from '../database/workers';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { JobAlreadyRunningError } from '../worker/runExecutor';
import type { RunResult, StepPreview } from '../../shared/types';
import { ConfirmationStore } from './confirmations';
import { callTool, CONFIRMATION_TOOL_NAMES, McpContext, READ_ONLY_TOOL_NAMES, TOOLS, toolListing } from './tools';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;
let changes: number;
let confirmations: ConfirmationStore;
let clock: number;
let hub: McpContext['hub'];
let runJob: ReturnType<typeof vi.fn>;
let ctx: McpContext;

const emptyResult = (): RunResult => ({
  startedAt: '', finishedAt: '', fileOutcomes: [], filesMoved: 2, filesCopied: 0, filesDeleted: 0,
  filesSkipped: 0, filesErrored: 0, filesExtracted: 0, filesZipped: 0,
});

beforeEach(async () => {
  root = makeTempDir('fileshuttle-mcp-tools-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  changes = 0;
  clock = 1_000_000;
  confirmations = new ConfirmationStore(() => clock);
  runJob = vi.fn(async () => emptyResult());
  const preview = (name: string): StepPreview =>
    ({
      mappingName: name, actionType: 'move', result: { ...emptyResult(), filesMoved: 1, fileOutcomes: [] },
      totalOutcomes: 1, truncated: false, totalBytes: 10, overwriteCount: 0,
    }) as unknown as StepPreview;
  hub = {
    previewMapping: vi.fn(async (config: { name: string }) => preview(config.name)),
    previewJob: vi.fn(async (id: number) => ({ jobId: id, jobName: 'J', steps: [preview('s')] })),
    checkFolder: vi.fn(async () => ({ status: 'ok' })),
    runJob,
    cancelJob: vi.fn(async () => true),
    getActiveRuns: vi.fn(() => []),
    connectedWorkerIds: vi.fn(() => [getLocalWorkerId(db)]),
  } as unknown as McpContext['hub'];
  ctx = { getDb: () => db, hub, afterChange: () => (changes += 1), runWaitMs: 200 };
});
afterEach(() => {
  db.close();
  removeDir(root);
});

type Call = Awaited<ReturnType<typeof callTool>>;
const call = (name: string, args: unknown = {}): Promise<Call> => callTool(ctx, confirmations, 'tok', name, args);
async function text(name: string, args: unknown = {}): Promise<{ text: string; isError?: boolean; outcome: string }> {
  const r = await call(name, args);
  if ('invalidParams' in r) throw new Error(r.invalidParams);
  return { ...r.output, outcome: r.outcome };
}
const codeOf = (t: string) => /confirm: "([A-Z0-9]{6})"/.exec(t)![1];

const mapping = (over: Record<string, unknown> = {}) => ({
  name: 'PDFs',
  sourcePath: path.join(root, 'src'),
  destPath: path.join(root, 'dest'),
  recursive: false,
  actionType: 'copy',
  conflictPolicy: 'skip',
  filters: [{ field: 'extension', operator: 'equals', value: 'pdf', group: 0 }],
  keepNewest: null,
  keepNewestPerExtension: false,
  ...over,
});
const jobOf = (mappingIds: number[], over: Record<string, unknown> = {}) => ({
  name: 'Nightly', scheduleType: 'manual', scheduleIntervalMinutes: null, scheduleDailyTimes: [], catchUp: false,
  mappingIds, ...over,
});

async function makeJob(actionType: string, conflictPolicy = 'skip'): Promise<{ mappingId: number; jobId: number }> {
  const m = JSON.parse((await text('save_mapping', { mapping: mapping({ actionType, conflictPolicy }) })).text);
  const j = JSON.parse((await text('save_job', { job: jobOf([m.mappingId]) })).text);
  return { mappingId: m.mappingId, jobId: j.jobId };
}

describe('the tool surface', () => {
  it('has every tool the plan asks for, each with an input schema', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'cancel_run', 'check_folder', 'delete_job', 'delete_mapping', 'get_active_runs', 'get_run_files',
      'get_run_history', 'list_folder', 'list_jobs', 'list_mappings', 'list_workers', 'preview_job',
      'preview_mapping', 'run_job', 'save_job', 'save_mapping', 'set_job_enabled', 'validate_job', 'validate_mapping',
    ]);
    for (const tool of TOOLS) {
      const listing = toolListing(tool);
      expect((listing.inputSchema as { type: string }).type).toBe('object');
      expect(listing.annotations).toBeDefined();
    }
  });

  it('marks read-only tools read-only and every confirming tool destructive', () => {
    expect(READ_ONLY_TOOL_NAMES.sort()).toEqual([
      'check_folder', 'get_active_runs', 'get_run_files', 'get_run_history', 'list_folder', 'list_jobs',
      'list_mappings', 'list_workers', 'preview_job', 'preview_mapping', 'validate_job', 'validate_mapping',
    ]);
    expect(CONFIRMATION_TOOL_NAMES.sort()).toEqual(['delete_job', 'delete_mapping', 'run_job', 'save_job', 'save_mapping', 'set_job_enabled']);
    for (const name of CONFIRMATION_TOOL_NAMES) {
      expect(TOOLS.find((t) => t.name === name)!.annotations.destructiveHint, name).toBe(true);
    }
  });

  it('turns the zod schemas into JSON Schema with the field descriptions', () => {
    const save = toolListing(TOOLS.find((t) => t.name === 'save_job')!);
    const props = save.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(props.properties).sort()).toEqual(['confirm', 'job']);
    expect(props.required).toEqual(['job']);
    expect(JSON.stringify(save.inputSchema)).toContain('Existing mapping ids');
  });
});

describe('read-only tools', () => {
  it('lists the workers with whether they are connected', async () => {
    const workers = JSON.parse((await text('list_workers')).text);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ kind: 'local', online: true });
  });

  it('previews a draft mapping through the hub and changes nothing', async () => {
    writeFile(path.join(root, 'src', 'a.pdf'), 'abc');
    const summary = JSON.parse((await text('preview_mapping', { mapping: mapping() })).text);
    expect(summary.wouldMove).toBe(1);
    expect(hub.previewMapping).toHaveBeenCalled();
    expect(listTree(path.join(root, 'dest'))).toEqual([]);
    expect(repo.listMappings(db)).toEqual([]);
    expect(changes).toBe(0);
  });

  it('lists mappings and jobs', async () => {
    const { jobId } = await makeJob('copy');
    const mappings = JSON.parse((await text('list_mappings')).text);
    expect(mappings[0].usedByJobs).toEqual(['Nightly']);
    const jobs = JSON.parse((await text('list_jobs')).text);
    expect(jobs[0]).toMatchObject({ id: jobId, switchedOn: false });
  });

  it('answers a bad argument with invalid params', async () => {
    const r = await call('get_run_history', { limit: 1000 });
    expect('invalidParams' in r && r.invalidParams).toMatch(/limit/);
    expect('invalidParams' in (await call('nope'))).toBe(true);
  });
});

describe('saving', () => {
  it('saves a NEW job switched off', async () => {
    const { jobId } = await makeJob('copy');
    expect(repo.getJob(db, jobId)!.enabled).toBe(false);
    expect(changes).toBe(2);
  });

  it('refuses a bad save with a reason and does not report a change', async () => {
    const r = await text('save_mapping', { mapping: mapping({ sourcePath: '' }) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not saved/);
    expect(changes).toBe(0);
  });

  it('keeps an existing job\'s state when editing it, and asks first when a switched-on job would become destructive', async () => {
    const { mappingId, jobId } = await makeJob('copy');
    repo.setJobEnabled(db, jobId, true);
    // A harmless edit to a switched-on job goes straight through and keeps it on.
    expect((await text('save_job', { job: jobOf([mappingId], { id: jobId, name: 'Renamed' }) })).outcome).toBe('ok');
    expect(repo.getJob(db, jobId)!.enabled).toBe(true);
    // Swapping in a delete step asks first.
    const del = JSON.parse((await text('save_mapping', { mapping: mapping({ name: 'Del', actionType: 'delete', destPath: '' }) })).text).mappingId;
    const r = await text('save_job', { job: jobOf([del], { id: jobId }) });
    expect(r.outcome).toBe('needs-confirmation');
    expect(repo.getJob(db, jobId)!.steps[0].id).toBe(mappingId);
  });

  it('asks first before a mapping used by a switched-on job becomes a delete', async () => {
    const { mappingId, jobId } = await makeJob('copy');
    const edit = { mapping: mapping({ id: mappingId, actionType: 'delete', destPath: '' }) };
    // While the job is off nothing can run it, so the edit goes through.
    expect((await text('save_mapping', edit)).outcome).toBe('ok');
    expect(repo.getMapping(db, mappingId)!.actionType).toBe('delete');
    // Back to copy, job on: now the same edit asks first and changes nothing until confirmed.
    await text('save_mapping', { mapping: mapping({ id: mappingId }) });
    repo.setJobEnabled(db, jobId, true);
    const first = await text('save_mapping', edit);
    expect(first.outcome).toBe('needs-confirmation');
    expect(repo.getMapping(db, mappingId)!.actionType).toBe('copy');
    expect((await text('save_mapping', { ...edit, confirm: codeOf(first.text) })).outcome).toBe('ok');
    expect(repo.getMapping(db, mappingId)!.actionType).toBe('delete');
  });
});

describe('confirmation flow', () => {
  it('delete_job: first call does nothing and returns a code; the confirmed call deletes', async () => {
    const { jobId } = await makeJob('copy');
    const first = await text('delete_job', { jobId });
    expect(first.outcome).toBe('needs-confirmation');
    expect(first.isError).toBeUndefined();
    expect(first.text).toContain('Ask the user to confirm this exact action before calling again with confirm.');
    expect(repo.getJob(db, jobId)).not.toBeNull();
    const done = await text('delete_job', { jobId, confirm: codeOf(first.text) });
    expect(done.outcome).toBe('ok');
    expect(repo.getJob(db, jobId)).toBeNull();
  });

  it('refuses a wrong code, a reused code, an expired code and changed arguments', async () => {
    const a = await makeJob('copy');
    const b = await makeJob('copy');
    const first = await text('delete_job', { jobId: a.jobId });
    const code = codeOf(first.text);

    expect((await text('delete_job', { jobId: a.jobId, confirm: 'WRONG1' })).outcome).toBe('error');
    // The code was meant for job a, not job b.
    expect((await text('delete_job', { jobId: b.jobId, confirm: code })).outcome).toBe('error');
    expect(repo.getJob(db, b.jobId)).not.toBeNull();
    expect(repo.getJob(db, a.jobId)).not.toBeNull();

    // The right code still works once (two wrong guesses so far are under the limit)...
    expect((await text('delete_job', { jobId: a.jobId, confirm: code })).outcome).toBe('ok');
    // ...and not twice.
    const reused = await text('delete_job', { jobId: a.jobId, confirm: code });
    expect(reused.isError).toBe(true);

    const second = await text('delete_job', { jobId: b.jobId });
    clock += 5 * 60 * 1000 + 1;
    const late = await text('delete_job', { jobId: b.jobId, confirm: codeOf(second.text) });
    expect(late.text).toMatch(/expired/);
    expect(repo.getJob(db, b.jobId)).not.toBeNull();
  });

  it('cancels a code after three wrong guesses', async () => {
    const { jobId } = await makeJob('copy');
    const code = codeOf((await text('delete_job', { jobId })).text);
    for (let i = 0; i < 3; i += 1) await text('delete_job', { jobId, confirm: 'AAAAAA' });
    expect((await text('delete_job', { jobId, confirm: code })).isError).toBe(true);
    expect(repo.getJob(db, jobId)).not.toBeNull();
  });

  it('delete_mapping is refused outright while a job uses it, and works after confirmation otherwise', async () => {
    const { mappingId, jobId } = await makeJob('copy');
    const refused = await text('delete_mapping', { mappingId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/still used by/);
    repo.deleteJob(db, jobId);
    const first = await text('delete_mapping', { mappingId });
    expect(first.outcome).toBe('needs-confirmation');
    expect((await text('delete_mapping', { mappingId, confirm: codeOf(first.text) })).outcome).toBe('ok');
    expect(repo.getMapping(db, mappingId)).toBeNull();
  });

  it('run_job: a copy-only job runs at once; a delete, move or overwrite job needs confirmation', async () => {
    const safe = await makeJob('copy');
    expect((await text('run_job', { jobId: safe.jobId })).outcome).toBe('ok');
    expect(runJob).toHaveBeenCalledTimes(1);

    for (const [action, policy] of [['delete', 'skip'], ['move', 'skip'], ['copy', 'overwrite']] as const) {
      runJob.mockClear();
      const { jobId } = await makeJob(action, policy);
      const first = await text('run_job', { jobId });
      expect(first.outcome, action + policy).toBe('needs-confirmation');
      expect(runJob).not.toHaveBeenCalled();
      const done = JSON.parse((await text('run_job', { jobId, confirm: codeOf(first.text) })).text);
      expect(done.moved).toBe(2);
      expect(runJob).toHaveBeenCalledWith(jobId, 'manual');
    }
  });

  it('set_job_enabled: switching off never asks; switching a destructive job on does', async () => {
    const { jobId } = await makeJob('delete');
    const first = await text('set_job_enabled', { jobId, enabled: true });
    expect(first.outcome).toBe('needs-confirmation');
    expect(repo.getJob(db, jobId)!.enabled).toBe(false);
    await text('set_job_enabled', { jobId, enabled: true, confirm: codeOf(first.text) });
    expect(repo.getJob(db, jobId)!.enabled).toBe(true);
    expect((await text('set_job_enabled', { jobId, enabled: false })).outcome).toBe('ok');
    expect(repo.getJob(db, jobId)!.enabled).toBe(false);

    const safe = await makeJob('copy');
    expect((await text('set_job_enabled', { jobId: safe.jobId, enabled: true })).outcome).toBe('ok');
  });

  it('run_job reports a run that is still going, a run already in progress, and a cancel', async () => {
    const { jobId } = await makeJob('copy');
    runJob.mockImplementationOnce(() => new Promise(() => undefined));
    expect(JSON.parse((await text('run_job', { jobId })).text)).toMatchObject({ started: true, finished: false });
    runJob.mockRejectedValueOnce(new JobAlreadyRunningError(jobId));
    expect((await text('run_job', { jobId })).text).toMatch(/already running/);
    expect(JSON.parse((await text('cancel_run', { jobId })).text)).toMatchObject({ cancelRequested: true });
  });
});
