import * as path from 'path';
import { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunResult } from '../../shared/types';
import * as repo from '../database/repository';
import { initDatabase } from '../database/schema';
import { listTree, makeTempDir, removeDir, writeFile } from '../engine/testUtils';
import { WatcherService } from './watcher';

vi.mock('../dbLocation', () => ({ getEffectiveDbPath: () => '' }));
vi.mock('../startupLog', () => ({ logStartupStep: () => undefined }));

// Real chokidar on real folders: the debounce (1.5 s) and write-stability wait (2 s) are real time.
const SLOW = 30_000;

let root: string;
let db: Database;
let watcher: WatcherService;
let completed: { jobId: number; result: RunResult }[];

beforeEach(async () => {
  root = makeTempDir('fileshuttle-watch-');
  db = await initDatabase(path.join(root, 'fileshuttle.db'));
  completed = [];
  watcher = new WatcherService(db, (jobId, result) => completed.push({ jobId, result }));
});
afterEach(async () => {
  watcher.shutdown();
  await new Promise((r) => setTimeout(r, 100)); // let chokidar release its handles before deleting the folder
  db.close();
  removeDir(root);
});

function addMapping(name: string, src: string, dest: string, actionType: 'move' | 'copy' = 'move') {
  return repo.createMapping(db, {
    name,
    sourcePath: src,
    destPath: dest,
    recursive: false,
    conflictPolicy: 'skip',
    enabled: true,
    scheduleType: 'manual',
    scheduleIntervalMinutes: null,
    scheduleDailyTime: null,
    filters: [],
    nextMappingId: null,
    actionType,
    keepNewest: null,
  });
}

const addWatchJob = (name: string, mappingIds: number[], catchUp = false) =>
  repo.createJob(db, {
    name,
    enabled: true,
    catchUp,
    scheduleType: 'watch',
    scheduleIntervalMinutes: null,
    scheduleDailyTimes: [],
    mappingIds,
  });

describe('WatcherService', () => {
  it(
    'runs the job when a file arrives, and a chained job does not re-trigger on its own output',
    async () => {
      const inbox = path.join(root, 'inbox');
      const staging = path.join(root, 'staging');
      const final = path.join(root, 'final');
      writeFile(path.join(inbox, '.keep'), ''); // make sure the folder exists before watching it
      writeFile(path.join(staging, '.keep'), '');
      // inbox -> staging -> final: staging is both step 1's output and step 2's input.
      // Step 2 COPIES, so the file stays in staging long enough for a watcher on it to fire --
      // that is exactly the self-trigger this guards against.
      const jobId = addWatchJob('chain', [
        addMapping('one', inbox, staging),
        addMapping('two', staging, final, 'copy'),
      ]);
      watcher.start();
      await new Promise((r) => setTimeout(r, 500)); // let the watchers become ready

      writeFile(path.join(inbox, 'incoming.txt'), 'hello');
      await vi.waitFor(() => expect(completed.length).toBeGreaterThanOrEqual(1), { timeout: 15_000, interval: 200 });

      expect(completed[0].jobId).toBe(jobId);
      expect(listTree(final)).toContain('incoming.txt');
      expect(listTree(staging)).toContain('incoming.txt');

      // Moving into staging must not have kicked off another run: wait well past debounce + stability.
      await new Promise((r) => setTimeout(r, 5000));
      expect(completed).toHaveLength(1);
    },
    SLOW
  );

  it(
    'watches the source of every step, not just the first',
    async () => {
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      writeFile(path.join(a, '.keep'), '');
      writeFile(path.join(b, '.keep'), '');
      addWatchJob('two-sources', [addMapping('from-a', a, path.join(root, 'out-a')), addMapping('from-b', b, path.join(root, 'out-b'))]);
      watcher.start();
      await new Promise((r) => setTimeout(r, 500));

      writeFile(path.join(b, 'late.txt'), 'x'); // only the SECOND step's source
      await vi.waitFor(() => expect(completed.length).toBeGreaterThanOrEqual(1), { timeout: 15_000, interval: 200 });

      expect(listTree(path.join(root, 'out-b'))).toContain('late.txt');
    },
    SLOW
  );

  it(
    'catchUp runs an opted-in watch job once, without any new file event',
    async () => {
      const inbox = path.join(root, 'inbox');
      writeFile(path.join(inbox, 'waiting.txt'), 'arrived while the app was closed');
      addWatchJob('catch', [addMapping('m', inbox, path.join(root, 'out'))], true);

      expect(watcher.catchUp()).toBe(1);
      await vi.waitFor(() => expect(completed.length).toBe(1), { timeout: 15_000, interval: 200 });

      expect(listTree(path.join(root, 'out'))).toEqual(['waiting.txt']);
    },
    SLOW
  );

  it('catchUp ignores watch jobs that did not opt in', () => {
    const inbox = path.join(root, 'inbox');
    writeFile(path.join(inbox, 'waiting.txt'));
    addWatchJob('no-catch', [addMapping('m', inbox, path.join(root, 'out'))], false);
    expect(watcher.catchUp()).toBe(0);
  });
});
