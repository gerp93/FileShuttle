import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import {
  AssistantJobInput,
  AssistantMappingInput,
  checkJob,
  checkMapping,
  listFolder,
  saveJob,
  saveMapping,
} from './actions';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

let root: string;
let db: Database;

beforeEach(async () => {
  root = makeTempDir('fileshuttle-agent-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
});
afterEach(() => {
  db.close();
  removeDir(root);
});

function mappingInput(overrides: Partial<AssistantMappingInput> = {}): AssistantMappingInput {
  return {
    name: 'PDFs',
    sourcePath: path.join(root, 'src'),
    destPath: path.join(root, 'dest'),
    recursive: false,
    actionType: 'move',
    conflictPolicy: 'skip',
    filters: [{ field: 'extension', operator: 'equals', value: 'pdf', group: 0 }],
    keepNewest: null,
    keepNewestPerExtension: false,
    ...overrides,
  };
}

function jobInput(mappingIds: number[], overrides: Partial<AssistantJobInput> = {}): AssistantJobInput {
  return {
    name: 'Nightly',
    scheduleType: 'daily_at',
    scheduleIntervalMinutes: null,
    scheduleDailyTimes: ['02:00'],
    catchUp: false,
    mappingIds,
    ...overrides,
  };
}

describe('saveMapping', () => {
  it('creates a mapping with no schedule of its own', () => {
    const id = saveMapping(db, mappingInput());
    const saved = repo.getMapping(db, id)!;
    expect(saved.name).toBe('PDFs');
    expect(saved.scheduleType).toBe('manual');
    expect(saved.filters).toHaveLength(1);
  });

  it('keeps whether an existing mapping is switched on when updating it', () => {
    const id = saveMapping(db, mappingInput());
    repo.setMappingEnabled(db, id, false);
    saveMapping(db, mappingInput({ id, name: 'Renamed' }));
    const saved = repo.getMapping(db, id)!;
    expect(saved.name).toBe('Renamed');
    expect(saved.enabled).toBe(false);
  });

  it('refuses a mapping the app would refuse', () => {
    expect(() => saveMapping(db, mappingInput({ sourcePath: '' }))).toThrow(/source folder/i);
    expect(() =>
      saveMapping(db, mappingInput({ filters: [{ field: 'size', operator: 'min', value: 'big', group: 0 }] }))
    ).toThrow(/size/i);
  });

  it('refuses to update a mapping that does not exist', () => {
    expect(() => saveMapping(db, mappingInput({ id: 999 }))).toThrow(/no mapping/i);
  });
});

describe('saveJob', () => {
  it('always saves a job switched off, so nothing runs until the user enables it', () => {
    const mappingId = saveMapping(db, mappingInput());
    const jobId = saveJob(db, jobInput([mappingId]));
    const job = repo.getJob(db, jobId)!;
    expect(job.enabled).toBe(false);
    expect(job.scheduleType).toBe('daily_at');
    expect(job.scheduleDailyTimes).toEqual(['02:00']);
    expect(job.steps.map((s) => s.id)).toEqual([mappingId]);
  });

  it('switches an already-enabled job off when it edits it', () => {
    const mappingId = saveMapping(db, mappingInput());
    const jobId = saveJob(db, jobInput([mappingId]));
    repo.setJobEnabled(db, jobId, true);
    saveJob(db, jobInput([mappingId], { id: jobId, name: 'Edited' }));
    const job = repo.getJob(db, jobId)!;
    expect(job.name).toBe('Edited');
    expect(job.enabled).toBe(false);
  });

  it('refuses an unusable schedule, an empty job, and unknown mappings', () => {
    const mappingId = saveMapping(db, mappingInput());
    expect(() => saveJob(db, jobInput([mappingId], { scheduleDailyTimes: [] }))).toThrow(/time/i);
    expect(() => saveJob(db, jobInput([]))).toThrow(/at least one mapping/i);
    expect(() => saveJob(db, jobInput([12345]))).toThrow(/no mapping with id 12345/i);
  });
});

describe('checkMapping', () => {
  it('warns about a missing source and a destination that will be created', async () => {
    writeFile(path.join(root, 'src', 'a.pdf'));
    const ok = await checkMapping(db, mappingInput());
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join(' ')).toMatch(/will be created/);

    const missing = await checkMapping(db, mappingInput({ sourcePath: path.join(root, 'nope') }));
    expect(missing.warnings.join(' ')).toMatch(/doesn.t exist/);
  });

  it('warns loudly about deleting everything', async () => {
    const check = await checkMapping(
      db,
      mappingInput({ actionType: 'delete', destPath: '', filters: [], conflictPolicy: 'skip' })
    );
    expect(check.warnings.join(' ')).toMatch(/DELETES/);
    expect(check.warnings.join(' ')).toMatch(/EVERY file/);
  });

  it('flags overwrite', async () => {
    const check = await checkMapping(db, mappingInput({ conflictPolicy: 'overwrite' }));
    expect(check.warnings.join(' ')).toMatch(/overwrite/);
  });
});

describe('checkJob', () => {
  it('warns when a step is switched off', () => {
    const id = saveMapping(db, mappingInput());
    repo.setMappingEnabled(db, id, false);
    expect(checkJob(db, jobInput([id])).warnings.join(' ')).toMatch(/switched off/);
  });
});

describe('listFolder', () => {
  it('lists names, sizes and dates, never contents, and counts extensions', async () => {
    writeFile(path.join(root, 'look', 'a.pdf'), '12345');
    writeFile(path.join(root, 'look', 'b.PDF'), '123');
    writeFile(path.join(root, 'look', 'sub', 'c.txt'), 'x');
    const shallow = await listFolder(path.join(root, 'look'));
    expect(shallow.entries.map((e) => e.path).sort()).toEqual(['a.pdf', 'b.PDF', 'sub']);
    expect(shallow.fileCount).toBe(2);
    expect(shallow.folderCount).toBe(1);
    expect(shallow.totalBytes).toBe(8);
    expect(shallow.extensionCounts).toEqual({ pdf: 2 });
    expect(JSON.stringify(shallow)).not.toContain('12345');

    const deep = await listFolder(path.join(root, 'look'), { recursive: true });
    expect(deep.entries.map((e) => e.path.replace(/\\/g, '/'))).toContain('sub/c.txt');
  });

  it('stops at the limit and says so', async () => {
    for (let i = 0; i < 5; i += 1) writeFile(path.join(root, 'many', `f${i}.txt`));
    const listing = await listFolder(path.join(root, 'many'), { limit: 3 });
    expect(listing.entries).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  it('refuses relative paths and things that are not folders', async () => {
    await expect(listFolder('relative\\path')).rejects.toThrow(/full path/);
    writeFile(path.join(root, 'file.txt'));
    await expect(listFolder(path.join(root, 'file.txt'))).rejects.toThrow(/not a folder/);
    expect(listTree(root)).toContain('file.txt');
  });
});
