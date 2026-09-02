import AdmZip from 'adm-zip';
import { shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { FileOutcome, MappingConfig, RunResult } from '../../shared/types';
import { buildRunResult } from '../database/repository';
import { evaluateFilters, partitionKeepNewest } from './filters';

interface Candidate {
  filePath: string;
  mtimeMs: number;
  stat: fs.Stats;
}

export async function runMapping(mapping: MappingConfig): Promise<RunResult> {
  const startedAt = new Date();
  const sourceRoot = mapping.sourcePath;
  const outcomes: FileOutcome[] = [];

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

      zipEntry(mapping, mapping.destPath, entryPath, stat, outcomes);
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
    await actOnFile(mapping, sourceRoot, destRoot, file.filePath, file.stat, outcomes);
  }

  return buildRunResult(startedAt, new Date(), outcomes);
}

async function actOnFile(
  mapping: MappingConfig,
  sourceRoot: string,
  destRoot: string | null,
  filePath: string,
  stat: fs.Stats,
  outcomes: FileOutcome[]
): Promise<void> {
  if (mapping.actionType === 'delete') {
    try {
      await shell.trashItem(filePath);
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
    await extractZipEntry(mapping, sourceRoot, destRoot!, filePath, stat, outcomes);
    return;
  }

  const destPath = resolveDestination(sourceRoot, destRoot!, filePath);
  let reason: string | null = null;
  if (fs.existsSync(destPath)) {
    const resolved = resolveConflict(destPath, mapping.conflictPolicy);
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
      moveOrCopy(filePath, resolved, mapping.actionType, outcomes, reason, stat.size);
      return;
    }
  }

  moveOrCopy(filePath, destPath, mapping.actionType, outcomes, reason, stat.size);
}

/** Extracts a matched .zip file into a same-named subfolder of destRoot, then trashes the zip. */
async function extractZipEntry(
  mapping: MappingConfig,
  sourceRoot: string,
  destRoot: string,
  filePath: string,
  stat: fs.Stats,
  outcomes: FileOutcome[]
): Promise<void> {
  const relative = path.relative(sourceRoot, filePath);
  const relDir = path.dirname(relative);
  const baseName = path.basename(filePath, path.extname(filePath));
  const targetDir = path.join(destRoot, relDir === '.' ? '' : relDir, baseName);

  let finalDir = targetDir;
  let reason: string | null = null;
  if (fs.existsSync(targetDir)) {
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
      finalDir = firstFreeDir(targetDir);
    }
  }

  try {
    fs.mkdirSync(finalDir, { recursive: true });
    new AdmZip(filePath).extractAllTo(finalDir, true);
    outcomes.push({ sourcePath: filePath, destPath: finalDir, outcome: 'extracted', reason, sizeBytes: stat.size });
  } catch (err) {
    outcomes.push({ sourcePath: filePath, destPath: finalDir, outcome: 'error', reason: String(err), sizeBytes: stat.size });
    return;
  }

  try {
    await shell.trashItem(filePath);
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
  outcomes: FileOutcome[]
): void {
  const name = path.basename(entryPath);
  const targetZip = path.join(destRoot, `${name}.zip`);
  const size = stat.isDirectory() ? null : stat.size;

  let finalZip = targetZip;
  let reason: string | null = null;
  if (fs.existsSync(targetZip)) {
    const resolved = resolveConflict(targetZip, mapping.conflictPolicy);
    if (resolved === null) {
      outcomes.push({ sourcePath: entryPath, destPath: null, outcome: 'skipped', reason: 'conflict_skip', sizeBytes: size });
      return;
    }
    reason = `conflict_${mapping.conflictPolicy}`;
    finalZip = resolved;
  }

  try {
    fs.mkdirSync(destRoot, { recursive: true });
    const zip = new AdmZip();
    if (stat.isDirectory()) {
      zip.addLocalFolder(entryPath, name);
    } else {
      zip.addLocalFile(entryPath);
    }
    zip.writeZip(finalZip);
    outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'zipped', reason, sizeBytes: size });
  } catch (err) {
    outcomes.push({ sourcePath: entryPath, destPath: finalZip, outcome: 'error', reason: String(err), sizeBytes: size });
  }
}

function firstFreeDir(dirPath: string): string {
  let n = 1;
  while (true) {
    const candidate = `${dirPath} (${n})`;
    if (!fs.existsSync(candidate)) return candidate;
    n += 1;
  }
}

function moveOrCopy(
  filePath: string,
  destPath: string,
  actionType: MappingConfig['actionType'],
  outcomes: FileOutcome[],
  reason: string | null,
  size: number
): void {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (actionType === 'copy') {
      fs.copyFileSync(filePath, destPath);
      fs.utimesSync(destPath, fs.statSync(filePath).atime, fs.statSync(filePath).mtime);
      outcomes.push({ sourcePath: filePath, destPath, outcome: 'copied', reason, sizeBytes: size });
    } else {
      fs.renameSync(filePath, destPath);
      outcomes.push({ sourcePath: filePath, destPath, outcome: 'moved', reason, sizeBytes: size });
    }
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
      fs.renameSync(original.destPath, original.sourcePath);
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

export function resolveConflict(destPath: string, policy: string): string | null {
  if (policy === 'overwrite') return destPath;
  if (policy === 'skip') return null;
  if (policy === 'auto_rename') return firstFreePath(destPath);
  throw new Error(`Unknown conflict policy: ${policy}`);
}

function firstFreePath(destPath: string): string {
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const stem = path.basename(destPath, ext);
  let n = 1;
  while (true) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    n += 1;
  }
}
