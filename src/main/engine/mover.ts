import * as fs from 'fs';
import * as path from 'path';
import { normalizeFolder, validateMappingPaths } from '../../shared/pathSafety';
import { FileOutcome, MappingConfig, RunResult } from '../../shared/types';
import { validateFilters } from '../../shared/validation';
import { buildRunResult } from '../database/repository';
import { evaluateFilters, partitionKeepNewest } from './filters';
import { electronTrash, TrashFn } from './trash';
import {
  createZip,
  DEFAULT_UNZIP_LIMITS,
  extractZipEntries,
  readZipEntries,
  resolveEntryTarget,
  UnsafeArchiveError,
  UnzipLimits,
  ZipEntryInfo,
} from './zipStream';

export type { TrashFn } from './trash';
export type { UnzipLimits } from './zipStream';

/** Live status of a running mapping, for progress displays. */
export interface RunProgress {
  phase: 'scanning' | 'processing';
  /** Files looked at so far while scanning the source folder. */
  scanned: number;
  /** Files handled so far (moved, copied, skipped, ...). */
  processed: number;
  /** Files that will be handled, once scanning and filtering have finished. */
  total: number | null;
}

export interface RunOptions {
  trash?: TrashFn;
  /**
   * Work out exactly what a run would do -- same candidate selection, filters,
   * keep-newest ranking and conflict resolution -- without touching anything
   * on disk. The returned outcomes are the ones a real run would produce.
   */
  dryRun?: boolean;
  /**
   * When a mapping's conflict policy is "overwrite", send the file being
   * replaced to the Recycle Bin first instead of destroying it. Defaults to
   * true. If the Recycle Bin can't take it (e.g. a network share), that file
   * is left alone and reported as an error rather than silently lost.
   */
  backupOverwritten?: boolean;
  /** Bounds on what unzip will extract (entry count, total size). */
  unzipLimits?: UnzipLimits;
  /** Called (throttled) as the run advances. */
  onProgress?: (progress: RunProgress) => void;
  /** Aborting stops the run before the next file; work already done is kept and reported. */
  signal?: AbortSignal;
}

const PROGRESS_INTERVAL_MS = 150;
const STAT_BATCH = 64;

/** Everything an action needs besides the file in front of it. */
interface RunContext {
  trash: TrashFn;
  dryRun: boolean;
  backupOverwritten: boolean;
  limits: UnzipLimits;
  signal?: AbortSignal;
  /**
   * Destinations a dry run has "used". A real run sees its own earlier output
   * on disk (e.g. two zips whose extraction folders collide); a dry run has to
   * remember those itself or it would report conflicts differently.
   */
  claimed: Set<string>;
  progress: { scanned: number; processed: number; total: number | null };
  emit: (phase: RunProgress['phase'], force?: boolean) => void;
}

/**
 * Why `p` can't be listed, or null when it can be -- or when it just doesn't
 * exist (a missing source is not an error). Unlike `pathExists`, this keeps the
 * OS's reason (EACCES, EPERM, a timed-out share, ...) instead of hiding it.
 */
async function sourceAccessError(p: string): Promise<string | null> {
  try {
    await fs.promises.access(p);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : errorText(err);
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function exists(ctx: RunContext, p: string): Promise<boolean> {
  return (ctx.dryRun && ctx.claimed.has(normalizeFolder(p))) || pathExists(p);
}

function claim(ctx: RunContext, p: string): void {
  if (ctx.dryRun) ctx.claimed.add(normalizeFolder(p));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeContext(options: RunOptions): RunContext {
  let lastEmit = 0;
  const ctx: RunContext = {
    trash: options.trash ?? electronTrash,
    dryRun: options.dryRun ?? false,
    backupOverwritten: options.backupOverwritten ?? true,
    limits: options.unzipLimits ?? DEFAULT_UNZIP_LIMITS,
    signal: options.signal,
    claimed: new Set(),
    progress: { scanned: 0, processed: 0, total: null },
    emit: (phase, force = false) => {
      if (!options.onProgress) return;
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastEmit = now;
      options.onProgress({ phase, ...ctx.progress });
    },
  };
  return ctx;
}

/**
 * Before an overwrite replaces `existingPath`, sends the old file to the
 * Recycle Bin so the replacement is recoverable. Returns a message when that
 * fails (the caller must then not overwrite), or null when it is safe to go on.
 */
async function backupExisting(ctx: RunContext, existingPath: string): Promise<string | null> {
  if (ctx.dryRun || !ctx.backupOverwritten) return null;
  if (!(await pathExists(existingPath))) return null;
  try {
    await ctx.trash(existingPath);
    return null;
  } catch (err) {
    return (
      `Not replaced: the existing file could not be moved to the Recycle Bin (${errorText(err)}). ` +
      'Turn off “Send replaced files to the Recycle Bin” in Settings to overwrite without a backup.'
    );
  }
}

/** Backs up every existing file that extracting `entries` into `targetDir` would overwrite. */
async function backupReplacedEntries(
  ctx: RunContext,
  entries: ZipEntryInfo[],
  targetDir: string
): Promise<string | null> {
  if (ctx.dryRun || !ctx.backupOverwritten) return null;
  for (const entry of entries) {
    if (entry.isDirectory || entry.isSymlink) continue;
    const target = resolveEntryTarget(targetDir, entry.name);
    if (!target) continue;
    try {
      if (!(await fs.promises.stat(target)).isFile()) continue;
    } catch {
      continue; // nothing there to replace
    }
    const failure = await backupExisting(ctx, target);
    if (failure) return failure;
  }
  return null;
}

interface Candidate {
  filePath: string;
  mtimeMs: number;
  stat: fs.Stats;
}

export async function runMapping(mapping: MappingConfig, options: RunOptions = {}): Promise<RunResult> {
  const ctx = makeContext(options);
  const startedAt = new Date();
  const sourceRoot = mapping.sourcePath;
  const outcomes: FileOutcome[] = [];
  const finish = () => buildRunResult(startedAt, new Date(), outcomes);

  // Mappings are validated when saved, but a database edited by hand, an
  // older build, or an imported file could still hold one that feeds on its
  // own output -- refuse to run it rather than loop.
  // Likewise a filter that can never evaluate (bad regex, size like "5MB",
  // unparseable date). Fail the mapping once, visibly, instead of throwing out
  // of the whole job or quietly matching nothing.
  const configProblem = validateMappingPaths(mapping) ?? validateFilters(mapping.filters);
  if (configProblem) {
    outcomes.push({
      sourcePath: sourceRoot,
      destPath: mapping.destPath || null,
      outcome: 'error',
      reason: configProblem,
      sizeBytes: null,
    });
    return finish();
  }

  const isZip = mapping.actionType === 'zip';
  const candidates: Candidate[] = [];

  // Scan: list the source folder and stat/filter in bounded parallel batches.
  // Everything here is async, so a huge folder never freezes the app.
  const found: string[] = [];
  // A source that exists but can't be read (permissions, a share that dropped,
  // a bad network path) must show up as an error with the OS's reason, not
  // abort the whole job with nothing recorded. A source that simply isn't
  // there stays a quiet no-op (the scan below yields nothing for it).
  const unreadable = await sourceAccessError(sourceRoot);
  if (unreadable) {
    outcomes.push({
      sourcePath: sourceRoot,
      destPath: mapping.destPath || null,
      outcome: 'error',
      reason: `Could not read the source folder: ${unreadable}`,
      sizeBytes: null,
    });
    return finish();
  }
  const entries = isZip ? iterTopLevelEntries(sourceRoot) : iterCandidateFiles(sourceRoot, mapping.recursive);
  try {
    for await (const entryPath of entries) {
      if (ctx.signal?.aborted) return finish();
      found.push(entryPath);
      ctx.progress.scanned = found.length;
      ctx.emit('scanning');
    }
  } catch (err) {
    // Keep what was found before the failure and say why the scan stopped.
    outcomes.push({
      sourcePath: sourceRoot,
      destPath: null,
      outcome: 'error',
      reason: `Scanning the source folder stopped early: ${errorText(err)}`,
      sizeBytes: null,
    });
  }

  for (let i = 0; i < found.length; i += STAT_BATCH) {
    if (ctx.signal?.aborted) return finish();
    const batch = found.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(
      batch.map((p) =>
        fs.promises.stat(p).then(
          (stat) => ({ stat }),
          (err: unknown) => ({ err })
        )
      )
    );
    batch.forEach((entryPath, j) => {
      const result = stats[j];
      if ('err' in result) {
        outcomes.push({ sourcePath: entryPath, destPath: null, outcome: 'error', reason: String(result.err), sizeBytes: null });
        return;
      }
      const { stat } = result;
      const matched = matchesMapping(
        mapping,
        entryPath,
        { size: isZip && stat.isDirectory() ? 0 : stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs },
        outcomes
      );
      if (matched) candidates.push({ filePath: entryPath, mtimeMs: stat.mtimeMs, stat });
    });
  }

  // Zip handles every matching top-level entry; there is no keep-newest for it.
  const keepNewest = mapping.actionType === 'copy' || isZip ? null : mapping.keepNewest;
  const { kept, rest } = partitionKeepNewest(candidates, keepNewest);

  for (const file of kept) {
    outcomes.push({
      sourcePath: file.filePath,
      destPath: null,
      outcome: 'skipped',
      reason: 'kept_newest',
      sizeBytes: file.stat.size,
    });
  }

  ctx.progress.total = rest.length;
  ctx.progress.processed = 0;
  ctx.emit('processing', true);

  const destRoot =
    mapping.actionType === 'move' || mapping.actionType === 'copy' || mapping.actionType === 'unzip'
      ? mapping.destPath
      : null;

  for (const file of rest) {
    if (ctx.signal?.aborted) break;
    if (isZip) {
      await zipEntry(mapping, mapping.destPath, file.filePath, file.stat, outcomes, ctx);
    } else {
      await actOnFile(mapping, sourceRoot, destRoot, file.filePath, file.stat, outcomes, ctx);
    }
    ctx.progress.processed += 1;
    ctx.emit('processing');
  }

  ctx.emit('processing', true);
  return finish();
}

/**
 * Filters were validated up front, so evaluating one should never throw; if it
 * somehow does, that file is reported as an error instead of aborting the run.
 */
function matchesMapping(
  mapping: MappingConfig,
  filePath: string,
  stat: { size: number; mtimeMs: number; birthtimeMs: number },
  outcomes: FileOutcome[]
): boolean {
  try {
    return evaluateFilters(filePath, stat, mapping.filters, mapping.filterMatchMode);
  } catch (err) {
    outcomes.push({ sourcePath: filePath, destPath: null, outcome: 'error', reason: errorText(err), sizeBytes: stat.size });
    return false;
  }
}

async function actOnFile(
  mapping: MappingConfig,
  sourceRoot: string,
  destRoot: string | null,
  filePath: string,
  stat: fs.Stats,
  outcomes: FileOutcome[],
  ctx: RunContext
): Promise<void> {
  if (mapping.actionType === 'delete') {
    try {
      if (!ctx.dryRun) await ctx.trash(filePath);
      outcomes.push({
        sourcePath: filePath,
        destPath: null,
        outcome: 'deleted',
        reason: null,
        sizeBytes: stat.size,
      });
    } catch (err) {
      outcomes.push({
        sourcePath: filePath,
        destPath: null,
        outcome: 'error',
        reason: String(err),
        sizeBytes: stat.size,
      });
    }
    return;
  }

  if (mapping.actionType === 'unzip') {
    await extractZipEntry(mapping, sourceRoot, destRoot!, filePath, stat, outcomes, ctx);
    return;
  }

  const destPath = resolveDestination(sourceRoot, destRoot!, filePath);
  let reason: string | null = null;
  if (await exists(ctx, destPath)) {
    const resolved = await resolveConflict(destPath, mapping.conflictPolicy, (p) => exists(ctx, p));
    if (resolved === null) {
      outcomes.push({
        sourcePath: filePath,
        destPath: null,
        outcome: 'skipped',
        reason: `conflict_${mapping.conflictPolicy}`,
        sizeBytes: stat.size,
      });
      return;
    }
    reason = `conflict_${mapping.conflictPolicy}`;
    if (resolved !== destPath) {
      await moveOrCopy(filePath, resolved, mapping.actionType, outcomes, reason, stat.size, ctx);
      return;
    }

    // Overwrite: keep the file being replaced recoverable.
    const failure = await backupExisting(ctx, destPath);
    if (failure) {
      outcomes.push({ sourcePath: filePath, destPath, outcome: 'error', reason: failure, sizeBytes: stat.size });
      return;
    }
  }

  await moveOrCopy(filePath, destPath, mapping.actionType, outcomes, reason, stat.size, ctx);
}

/** Extracts a matched .zip file into a same-named subfolder of destRoot, then trashes the zip. */
async function extractZipEntry(
  mapping: MappingConfig,
  sourceRoot: string,
  destRoot: string,
  filePath: string,
  stat: fs.Stats,
  outcomes: FileOutcome[],
  ctx: RunContext
): Promise<void> {
  const relative = path.relative(sourceRoot, filePath);
  const relDir = path.dirname(relative);
  const baseName = path.basename(filePath, path.extname(filePath));
  const targetDir = path.join(destRoot, relDir === '.' ? '' : relDir, baseName);

  let finalDir = targetDir;
  let reason: string | null = null;
  if (await exists(ctx, targetDir)) {
    if (mapping.conflictPolicy === 'skip') {
      outcomes.push({
        sourcePath: filePath,
        destPath: null,
        outcome: 'skipped',
        reason: 'conflict_skip',
        sizeBytes: stat.size,
      });
      return;
    }
    reason = `conflict_${mapping.conflictPolicy}`;
    if (mapping.conflictPolicy === 'auto_rename') {
      finalDir = await firstFreeDir(targetDir, (p) => exists(ctx, p));
    }
  }

  const folderIsNew = !(await pathExists(finalDir));
  let opened: Awaited<ReturnType<typeof readZipEntries>> | null = null;
  try {
    // Reading the table of contents is read-only. In a preview it still
    // surfaces a corrupt or oversized archive before the real run does.
    opened = await readZipEntries(filePath, ctx.limits);
    if (ctx.dryRun) {
      claim(ctx, finalDir);
    } else {
      if (mapping.conflictPolicy === 'overwrite' && finalDir === targetDir) {
        const failure = await backupReplacedEntries(ctx, opened.entries, finalDir);
        if (failure) {
          outcomes.push({ sourcePath: filePath, destPath: finalDir, outcome: 'error', reason: failure, sizeBytes: stat.size });
          return;
        }
      }
      await extractZipEntries(opened.zipfile, opened.entries, finalDir, ctx.limits, ctx.signal);
    }
    outcomes.push({ sourcePath: filePath, destPath: finalDir, outcome: 'extracted', reason, sizeBytes: stat.size });
  } catch (err) {
    // A folder we just created for this archive holds only a partial extraction; don't leave it behind.
    if (!ctx.dryRun && folderIsNew) await fs.promises.rm(finalDir, { recursive: true, force: true });
    outcomes.push({
      sourcePath: filePath,
      destPath: finalDir,
      outcome: 'error',
      reason: err instanceof UnsafeArchiveError ? `Not extracted: ${errorText(err)}` : String(err),
      sizeBytes: stat.size,
    });
    return;
  } finally {
    opened?.close();
  }

  if (ctx.dryRun) return;

  try {
    await ctx.trash(filePath);
  } catch (err) {
    outcomes.push({
      sourcePath: filePath,
      destPath: finalDir,
      outcome: 'error',
      reason: `Extracted, but could not remove the original zip: ${String(err)}`,
      sizeBytes: stat.size,
    });
  }
}

/** Compresses a top-level source file or folder into destRoot/<name>.zip, leaving the original in place. */
async function zipEntry(
  mapping: MappingConfig,
  destRoot: string,
  entryPath: string,
  stat: fs.Stats,
  outcomes: FileOutcome[],
  ctx: RunContext
): Promise<void> {
  const name = path.basename(entryPath);
  const targetZip = path.join(destRoot, `${name}.zip`);
  const size = stat.isDirectory() ? null : stat.size;

  let finalZip = targetZip;
  let reason: string | null = null;
  if (await exists(ctx, targetZip)) {
    const resolved = await resolveConflict(targetZip, mapping.conflictPolicy, (p) => exists(ctx, p));
    if (resolved === null) {
      outcomes.push({ sourcePath: entryPath, destPath: null, outcome: 'skipped', reason: 'conflict_skip', sizeBytes: size });
      return;
    }
    reason = `conflict_${mapping.conflictPolicy}`;
    finalZip = resolved;
    if (resolved === targetZip) {
      const failure = await backupExisting(ctx, targetZip);
      if (failure) {
        outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'error', reason: failure, sizeBytes: size });
        return;
      }
    }
  }

  try {
    if (ctx.dryRun) {
      claim(ctx, finalZip);
    } else {
      await fs.promises.mkdir(destRoot, { recursive: true });
      await createZip(entryPath, name, stat.isDirectory(), finalZip);
    }
    outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'zipped', reason, sizeBytes: size });
  } catch (err) {
    outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'error', reason: String(err), sizeBytes: size });
  }
}

async function firstFreeDir(dirPath: string, taken: (p: string) => Promise<boolean>): Promise<string> {
  let n = 1;
  while (true) {
    const candidate = `${dirPath} (${n})`;
    if (!(await taken(candidate))) return candidate;
    n += 1;
  }
}

/**
 * rename fails with EXDEV when source and destination are on different
 * drives/volumes (common here: moving into a different drive letter, a mapped
 * network drive, etc.) -- the OS can't do an in-place rename across devices.
 * Fall back to copy-then-delete in that case, same as `mv` does.
 */
export async function renameOrCopyAcrossDevices(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const stat = await fs.promises.stat(src);
    await fs.promises.copyFile(src, dest);
    await fs.promises.utimes(dest, stat.atime, stat.mtime);
    await fs.promises.rm(src);
  }
}

async function moveOrCopy(
  filePath: string,
  destPath: string,
  actionType: MappingConfig['actionType'],
  outcomes: FileOutcome[],
  reason: string | null,
  size: number,
  ctx: RunContext
): Promise<void> {
  try {
    if (ctx.dryRun) {
      claim(ctx, destPath);
    } else {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      if (actionType === 'copy') {
        await fs.promises.copyFile(filePath, destPath);
        const source = await fs.promises.stat(filePath);
        await fs.promises.utimes(destPath, source.atime, source.mtime);
      } else {
        await renameOrCopyAcrossDevices(filePath, destPath);
      }
    }
    outcomes.push({
      sourcePath: filePath,
      destPath,
      outcome: actionType === 'copy' ? 'copied' : 'moved',
      reason,
      sizeBytes: size,
    });
  } catch (err) {
    outcomes.push({ sourcePath: filePath, destPath, outcome: 'error', reason: String(err), sizeBytes: size });
  }
}

export async function* iterTopLevelEntries(source: string): AsyncGenerator<string> {
  if (!(await pathExists(source))) return;
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    yield path.join(source, entry.name);
  }
}

export async function* iterCandidateFiles(source: string, recursive: boolean): AsyncGenerator<string> {
  if (!(await pathExists(source))) return;
  if (recursive) {
    yield* walkRecursive(source);
  } else {
    for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
      if (entry.isFile()) {
        yield path.join(source, entry.name);
      }
    }
  }
}

async function* walkRecursive(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      yield fullPath;
    } else if (entry.isDirectory()) {
      yield* walkRecursive(fullPath);
    }
  }
}

export function resolveDestination(sourceRoot: string, destRoot: string, filePath: string): string {
  const relative = path.relative(sourceRoot, filePath);
  return path.join(destRoot, relative);
}

export async function resolveConflict(
  destPath: string,
  policy: string,
  taken: (p: string) => Promise<boolean> = pathExists
): Promise<string | null> {
  if (policy === 'overwrite') return destPath;
  if (policy === 'skip') return null;
  if (policy === 'auto_rename') return firstFreePath(destPath, taken);
  throw new Error(`Unknown conflict policy: ${policy}`);
}

async function firstFreePath(destPath: string, taken: (p: string) => Promise<boolean>): Promise<string> {
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  let n = 1;
  while (true) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!(await taken(candidate))) return candidate;
    n += 1;
  }
}
