import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import type { AgentSdk } from './sdk';
import { createFileShuttleServer, READ_ONLY_TOOLS, SERVER_NAME, WRITE_TOOLS } from './tools';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

type Handler = (input: any) => Promise<{ content: { text: string }[]; isError?: boolean }>;

// A stand-in for the Claude SDK that just collects the tools it is given.
const fakeSdk = {
  tool: (name: string, _description: string, _shape: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: ({ tools }: { tools: { name: string; handler: Handler }[] }) => tools,
} as unknown as AgentSdk;

let root: string;
let db: Database;
let changes: number;
let tools: Map<string, Handler>;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-tools-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  changes = 0;
  const list = createFileShuttleServer(fakeSdk, { getDb: () => db, afterChange: () => (changes += 1) }) as unknown as {
    name: string;
    handler: Handler;
  }[];
  tools = new Map(list.map((t) => [t.name, t.handler]));
});
afterEach(() => {
  db.close();
  removeDir(root);
});

const text = (r: { content: { text: string }[] }) => r.content[0].text;

describe('the assistant tool surface', () => {
  it('cannot run, delete, enable, or undo anything', () => {
    const names = [...tools.keys()];
    for (const forbidden of ['run', 'delete', 'remove', 'enable', 'undo', 'cancel', 'purge', 'clone']) {
      expect(names.filter((n) => n.startsWith(`${forbidden}_`)), forbidden).toEqual([]);
    }
  });

  it('lists exactly the tools the permission lists know about', () => {
    const prefixed = [...tools.keys()].map((n) => `mcp__${SERVER_NAME}__${n}`).sort();
    expect(prefixed).toEqual([...READ_ONLY_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('only the two save tools change anything', () => {
    expect(WRITE_TOOLS.map((n) => n.replace(`mcp__${SERVER_NAME}__`, '')).sort()).toEqual(['save_job', 'save_mapping']);
  });
});

describe('tools', () => {
  const mapping = () => ({
    name: 'PDFs',
    sourcePath: path.join(root, 'src'),
    destPath: path.join(root, 'dest'),
    recursive: false,
    actionType: 'move',
    conflictPolicy: 'skip',
    filters: [{ field: 'extension', operator: 'equals', value: 'pdf', group: 0 }],
    keepNewest: null,
    keepNewestPerExtension: false,
  });

  it('previews a draft mapping as a dry run and changes nothing on disk or in the database', async () => {
    writeFile(path.join(root, 'src', 'a.pdf'), 'abc');
    writeFile(path.join(root, 'src', 'b.txt'), 'abc');
    const result = await tools.get('preview_mapping')!({ mapping: mapping() });
    const summary = JSON.parse(text(result));
    expect(summary.wouldMove).toBe(1);
    expect(listTree(path.join(root, 'src'))).toEqual(['a.pdf', 'b.txt']);
    expect(listTree(path.join(root, 'dest'))).toEqual([]);
    expect(repo.listMappings(db)).toEqual([]);
    expect(changes).toBe(0);
  });

  it('saves a mapping then a job, reports the change, and leaves the job off', async () => {
    const saved = JSON.parse(text(await tools.get('save_mapping')!({ mapping: mapping() })));
    expect(saved.saved).toBe(true);
    const job = {
      name: 'Nightly',
      scheduleType: 'interval',
      scheduleIntervalMinutes: 60,
      scheduleDailyTimes: [],
      catchUp: false,
      mappingIds: [saved.mappingId],
    };
    const savedJob = JSON.parse(text(await tools.get('save_job')!({ job })));
    expect(savedJob.switchedOn).toBe(false);
    expect(repo.getJob(db, savedJob.jobId)!.enabled).toBe(false);
    expect(changes).toBe(2);
  });

  it('refuses a bad save with a reason and does not report a change', async () => {
    const result = await tools.get('save_mapping')!({ mapping: { ...mapping(), sourcePath: '' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Not saved/);
    expect(repo.listMappings(db)).toEqual([]);
    expect(changes).toBe(0);
  });

  it('lists mappings and jobs', async () => {
    const saved = JSON.parse(text(await tools.get('save_mapping')!({ mapping: mapping() })));
    await tools.get('save_job')!({
      job: {
        name: 'J',
        scheduleType: 'manual',
        scheduleIntervalMinutes: null,
        scheduleDailyTimes: [],
        catchUp: false,
        mappingIds: [saved.mappingId],
      },
    });
    const mappings = JSON.parse(text(await tools.get('list_mappings')!({})));
    expect(mappings[0].usedByJobs).toEqual(['J']);
    const jobs = JSON.parse(text(await tools.get('list_jobs')!({})));
    expect(jobs[0].steps[0].name).toBe('PDFs');
    expect(jobs[0].switchedOn).toBe(false);
  });
});
