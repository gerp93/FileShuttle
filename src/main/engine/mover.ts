import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeFolder, validateMappingPaths } from '../../shared/pathSafety';
import { FileOutcome, MappingConfig, RunResult } from '../../shared/types';
import { buildRunResult } from '../database/repository';
import { evaluateFilters, partitionKeepNewest } from './filters';

/** Sends a path to the Recycle Bin. Injected so the engine can run (and be tested) outside Electron. */
export type TrashFn = (filePath: string) => Promise<void>;

export interface RunOptions {
  trash?: TrashFn;
  /**
   * Work out exactly what a run would do -- same candidate selection, filters,
   * keep-newest ranking and conflict resolution -- without touching anything
   * on disk. The returned outcomes are the ones a real run would produce.
   */
  dryRun?: boolean;
}

const electronTrash: TrashFn = async (filePath) => {
  const { shell } = await import('electron');
  await shell.trashItem(filePath);
};

/** Everything an action needs besides the file in front of it. */
interface RunContext {
  trash: TrashFn;
  dryRun: boolean;
  /**
   * Destinations a dry run has "used". A real run sees its own earlier output
   * on disk (e.g. two zips whose extraction folders collide); a dry run has to
   * remember those itself or it would report conflicts differently.
   */
  claimed: Set<string>;
}

function exists(ctx: RunContext, p: string): boolean {
  return fs.existsSync(p) || (ctx.dryRun && ctx.claimed.has(normalizeFolder(p)));
}

function claim(ctx: RunContext, p: string): void {
  if (ctx.dryRun) ctx.claimed.add(normalizeFolder(p));
}

interface Candidate {
  filePath: string;
  mtimeMs: number;
  stat: fs.Stats;
}

export async function runMapping(mapping: MappingConfig, options: RunOptions = {}): Promise<RunResult> {
  const ctx: RunContext = {
    trash: options.trash ?? electronTrash,
    dryRun: options.dryRun ?? false,
    claimed: new Set(),
  };
  const startedAt = new Date();
  const sourceRoot = mapping.sourcePath;
  const outcomes: FileOutcome[] = [];

  // Mappings are validated when saved, but a database edited by hand, an
  // older build, or an imported file could still hold one that feeds on its
  // own output -- refuse to run it rather than loop.
  const pathProblem = validateMappingPaths(mapping);
  if (pathProblem) {
    outcomes.push({
      sourcePath: sourceRoot,
      destPath: mapping.destPath || null,
      outcome: 'error',
      reason: pathProblem,
      sizeBytes: null,
    });
    return buildRunResult(startedAt, new Date(), outcomes);
  }

  if (mapping.actionType === 'zip') {
    for (const entryPath of iterTopLevelEntries(sourceRoot)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(entryPath);
      } catch (err) {
        outcomes.push({ sourcePath: entryPath, destPath: null, outcome: 'error', reason: String(err), sizeBytes: null });
        continue;
      }

      if (
        !evaluateFilters(
          entryPath,
          { size: stat.isDirectory() ? 0 : stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs },
          mapping.filters,
          mapping.filterMatchMode
        )
      ) {
        continue;
      }

      zipEntry(mapping, mapping.destPath, entryPath, stat, outcomes, ctx);
    }
    return buildRunResult(startedAt, new Date(), outcomes);
  }

  const destRoot =
    mapping.actionType === 'move' || mapping.actionType === 'copy' || mapping.actionType === 'unzip'
      ? mapping.destPath
      : null;
  const candidates: Candidate[] = [];

  for (const filePath of iterCandidateFiles(sourceRoot, mapping.recursive)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      outcomes.push({
        sourcePath: filePath,
        destPath: null,
        outcome: 'error',
        reason: String(err),
        sizeBytes: null,
      });
      continue;
    }

    if (
      !evaluateFilters(
        filePath,
        { size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs },
        mapping.filters,
        mapping.filterMatchMode
      )
    ) {
      continue;
    }

    candidates.push({ filePath, mtimeMs: stat.mtimeMs, stat });
  }

  const keepNewest = mapping.actionType === 'copy' ? null : mapping.keepNewest;
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

  for (const file of rest) {
    await actOnFile(mapping, sourceRoot, destRoot, file.filePath, file.stat, outcomes, ctx);
  }

  return buildRunResult(startedAt, new Date(), outcomes);
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
  if (exists(ctx, destPath)) {
    const resolved = resolveConflict(destPath, mapping.conflictPolicy, (p) => exists(ctx, p));
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
      moveOrCopy(filePath, resolved, mapping.actionType, outcomes, reason, stat.size, ctx);
      return;
    }
  }

  moveOrCopy(filePath, destPath, mapping.actionType, outcomes, reason, stat.size, ctx);
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
  if (exists(ctx, targetDir)) {
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
      finalDir = firstFreeDir(targetDir, (p) => exists(ctx, p));
    }
  }

  try {
    if (ctx.dryRun) {
      // Opening the archive only reads it, and it surfaces a corrupt zip in
      // the preview instead of on the real run.
      new AdmZip(filePath);
      claim(ctx, finalDir);
    } else {
      fs.mkdirSync(finalDir, { recursive: true });
      new AdmZip(filePath).extractAllTo(finalDir, true);
    }
    outcomes.push({ sourcePath: filePath, destPath: finalDir, outcome: 'extracted', reason, sizeBytes: stat.size });
  } catch (err) {
    outcomes.push({ sourcePath: filePath, destPath: finalDir, outcome: 'error', reason: String(err), sizeBytes: stat.size });
    return;
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
function zipEntry(
  mapping: MappingConfig,
  destRoot: string,
  entryPath: string,
  stat: fs.Stats,
  outcomes: FileOutcome[],
  ctx: RunContext
): void {
  const name = path.basename(entryPath);
  const targetZip = path.join(destRoot, `${name}.zip`);
  const size = stat.isDirectory() ? null : stat.size;

  let finalZip = targetZip;
  let reason: string | null = null;
  if (exists(ctx, targetZip)) {
    const resolved = resolveConflict(targetZip, mapping.conflictPolicy, (p) => exists(ctx, p));
    if (resolved === null) {
      outcomes.push({ sourcePath: entryPath, destPath: null, outcome: 'skipped', reason: 'conflict_skip', sizeBytes: size });
      return;
    }
    reason = `conflict_${mapping.conflictPolicy}`;
    finalZip = resolved;
  }

  try {
    if (ctx.dryRun) {
      claim(ctx, finalZip);
    } else {
      fs.mkdirSync(destRoot, { recursive: true });
      const zip = new AdmZip();
      if (stat.isDirectory()) {
        zip.addLocalFolder(entryPath, name);
      } else {
        zip.addLocalFile(entryPath);
      }
      zip.writeZip(finalZip);
    }
    outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'zipped', reason, sizeBytes: size });
  } catch (err) {
    outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'error', reason: String(err), sizeBytes: size });
  }
}

function firstFreeDir(dirPath: string, taken: (p: string) => boolean = fs.existsSync): string {
  let n = 1;
  while (true) {
    const candidate = `${dirPath} (${n})`;
    if (!taken(candidate)) return candidate;
    n += 1;
  }
}

/**
 * fs.renameSync fails with EXDEV when source and destination are on different
 * drives/volumes (common here: moving into a different drive letter, a mapped
 * network drive, etc.) -- the OS can't do an in-place rename across devices.
 * Fall back to copy-then-delete in that case, same as `mv` does.
 */
function renameOrCopyAcrossDevices(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    const stat = fs.statSync(src);
    fs.copyFileSync(src, dest);
    fs.utimesSync(dest, stat.atime, stat.mtime);
    fs.rmSync(src);
  }
}

function moveOrCopy(
  filePath: string,
  destPath: string,
  actionType: MappingConfig['actionType'],
  outcomes: FileOutcome[],
  reason: string | null,
  size: number,
  ctx: RunContext
): void {
  try {
    if (ctx.dryRun) {
      claim(ctx, destPath);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (actionType === 'copy') {
        fs.copyFileSync(filePath, destPath);
        fs.utimesSync(destPath, fs.statSync(filePath).atime, fs.statSync(filePath).mtime);
      } else {
        renameOrCopyAcrossDevices(filePath, destPath);
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

export function undoRun(fileOutcomes: FileOutcome[]): RunResult {
  const startedAt = new Date();
  const outcomes: FileOutcome[] = [];

  for (const original of fileOutcomes) {
    if (original.outcome !== 'moved' || !original.destPath) continue;

    if (!fs.existsSync(original.destPath)) {
      outcomes.push({
        sourcePath: original.destPath,
        destPath: original.sourcePath,
        outcome: 'error',
        reason: 'file no longer exists at its recorded destination',
        sizeBytes: null,
      });
      continue;
    }

    if (fs.existsSync(original.sourcePath)) {
      outcomes.push({
        sourcePath: original.destPath,
        destPath: null,
        outcome: 'skipped',
        reason: 'a file already exists at the original source path',
        sizeBytes: null,
      });
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(original.sourcePath), { recursive: true });
      const size = fs.statSync(original.destPath).size;
      renameOrCopyAcrossDevices(original.destPath, original.sourcePath);
      outcomes.push({
        sourcePath: original.destPath,
        destPath: original.sourcePath,
        outcome: 'moved',
        reason: null,
        sizeBytes: size,
      });
    } catch (err) {
      outcomes.push({
        sourcePath: original.destPath,
        destPath: original.sourcePath,
        outcome: 'error',
        reason: String(err),
        sizeBytes: null,
      });
    }
  }

  return buildRunResult(startedAt, new Date(), outcomes);
}

export function* iterTopLevelEntries(source: string): Generator<string> {
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    yield path.join(source, entry.name);
  }
}

export function* iterCandidateFiles(source: string, recursive: boolean): Generator<string> {
  if (!fs.existsSync(source)) return;
  if (recursive) {
    yield* walkRecursive(source);
  } else {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isFile()) {
        yield path.join(source, entry.name);
      }
    }
  }
}

function* walkRecursive(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

export function resolveConflict(
  destPath: string,
  policy: string,
  taken: (p: string) => boolean = fs.existsSync
): string | null {
  if (policy === 'overwrite') return destPath;
  if (policy === 'skip') return null;
  if (policy === 'auto_rename') return firstFreePath(destPath, taken);
  throw new Error(`Unknown conflict policy: ${policy}`);
}

function firstFreePath(destPath: string, taken: (p: string) => boolean): string {
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  let n = 1;
  while (true) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!taken(candidate)) return candidate;
    n += 1;
  }
}
