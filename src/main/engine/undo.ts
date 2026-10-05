import * as fs from 'fs';
import * as path from 'path';
import { planUndo, UndoAction } from '../../shared/undoPlan';
import { FileOutcome, RunResult } from '../../shared/types';
import { buildRunResult } from '../database/repository';
import { pathExists, renameOrCopyAcrossDevices } from './mover';
import { restoreFromRecycleBin, RestoreFn, RestoreRequest, RestoreResult } from './recycleBin';
import { electronTrash, TrashFn } from './trash';

export interface UndoOptions {
  trash?: TrashFn;
  restore?: RestoreFn;
  /** When the run being undone happened; limits which Recycle Bin items may be restored. */
  window?: { startedAt: string; finishedAt: string };
  /** The run being undone is itself an undo; only reverse its moves. */
  originalWasUndo?: boolean;
}

// Deletion times in the bin have one-second resolution and come from the file
// system clock; leave some slack either side of the run.
const WINDOW_SLACK_MS = 10_000;

const BIN_MISSING = 'it is no longer in the Recycle Bin (it may have been emptied or restored already)';

function describeRestoreFailure(result: RestoreResult): string {
  switch (result.status) {
    case 'not_found':
      return BIN_MISSING;
    case 'blocked':
      return result.reason ?? 'something already exists at the original location';
    case 'unsupported':
      return result.reason ?? 'restoring from the Recycle Bin is not supported on this system';
    default:
      return result.reason ?? 'the Recycle Bin could not restore it';
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reverses a recorded run according to `planUndo`. Never overwrites anything:
 * a move is only reversed if the original spot is free, and files are only
 * restored if their original location is empty.
 */
export async function undoRun(fileOutcomes: FileOutcome[], options: UndoOptions = {}): Promise<RunResult> {
  const startedAt = new Date();
  const trash = options.trash ?? electronTrash;
  const restore = options.restore ?? restoreFromRecycleBin;
  const outcomes: FileOutcome[] = [];

  const runStart = options.window ? Date.parse(options.window.startedAt) : Date.now();
  const runEnd = options.window ? Date.parse(options.window.finishedAt) : Date.now();
  const request = (p: string): RestoreRequest => ({
    path: p,
    notBeforeMs: runStart - WINDOW_SLACK_MS,
    notAfterMs: runEnd + WINDOW_SLACK_MS,
  });

  const plan = planUndo(fileOutcomes, options.originalWasUndo ?? false);

  for (const { outcome, reason } of plan.notUndoable) {
    outcomes.push({
      sourcePath: outcome.destPath ?? outcome.sourcePath,
      destPath: null,
      outcome: 'skipped',
      reason: `not undone: ${reason}`,
      sizeBytes: outcome.sizeBytes,
    });
  }

  // Stage 1: bring back what was binned (deleted files, and the zips that
  // were consumed by an unzip). Extracted folders are only removed if their
  // zip could be restored, so an undo can never leave the user with neither.
  const restoreFirst = plan.actions.filter((a) => a.kind === 'restore_deleted' || a.kind === 'remove_extracted');
  const firstResults = new Map<string, RestoreResult>();
  if (restoreFirst.length) {
    const results = await restore(restoreFirst.map((a) => request(a.outcome.sourcePath)));
    for (const r of results) firstResults.set(r.path, r);
  }

  const replacedToRestore: UndoAction[] = [];
  const asides: { aside: string; target: string; label: string; sizeBytes: number | null }[] = [];

  for (const action of plan.actions) {
    const { outcome: original } = action;

    if (action.kind === 'restore_deleted') {
      const result = firstResults.get(original.sourcePath);
      if (result?.status === 'restored') {
        outcomes.push({
          sourcePath: original.sourcePath,
          destPath: original.sourcePath,
          outcome: 'moved',
          reason: 'restored from the Recycle Bin',
          sizeBytes: original.sizeBytes,
        });
      } else {
        outcomes.push({
          sourcePath: original.sourcePath,
          destPath: null,
          outcome: result?.status === 'blocked' ? 'skipped' : 'error',
          reason: result ? describeRestoreFailure(result) : 'no result from the Recycle Bin',
          sizeBytes: original.sizeBytes,
        });
      }
      continue;
    }

    if (action.kind === 'move_back') {
      if ((await undoMoveBack(original, outcomes)) && action.restoreReplaced) replacedToRestore.push(action);
      continue;
    }

    if (action.kind === 'remove_extracted') {
      const zipResult = firstResults.get(original.sourcePath);
      // "blocked" with the zip present means it was already put back by hand.
      const zipBack = zipResult?.status === 'restored' || (zipResult?.status === 'blocked' && (await pathExists(original.sourcePath)));
      if (!zipBack) {
        outcomes.push({
          sourcePath: original.destPath!,
          destPath: null,
          outcome: 'error',
          reason: `kept the extracted folder because the original zip could not be restored: ${
            zipResult ? describeRestoreFailure(zipResult) : 'no result from the Recycle Bin'
          }`,
          sizeBytes: original.sizeBytes,
        });
        continue;
      }
      await removeCreated(original.destPath!, 'removed the extracted folder', original.sizeBytes, trash, outcomes);
      continue;
    }

    // remove_copy / remove_archive
    const label = action.kind === 'remove_copy' ? 'removed the copy' : 'removed the archive';
    const target = original.destPath!;

    if (action.restoreReplaced && (await pathExists(target))) {
      // The replaced file is in the Recycle Bin under this very path. If we
      // binned the copy first, the two would be indistinguishable (the bin
      // only keeps one-second timestamps), so move the copy out of the way,
      // restore the old file into the freed path, and only then bin the copy.
      const aside = `${target}.fileshuttle-undo-${Date.now()}-${asides.length}`;
      try {
        await fs.promises.rename(target, aside);
        asides.push({ aside, target, label, sizeBytes: original.sizeBytes });
        replacedToRestore.push(action);
      } catch (err) {
        outcomes.push({
          sourcePath: target,
          destPath: null,
          outcome: 'error',
          reason: `could not remove it: ${errText(err)}`,
          sizeBytes: original.sizeBytes,
        });
      }
      continue;
    }

    const removed = await removeCreated(target, label, original.sizeBytes, trash, outcomes);
    if (removed && action.restoreReplaced) replacedToRestore.push(action);
  }

  // Stage 3: the run replaced files at these destinations; now that the
  // destination is free again, bring the replaced files back.
  if (replacedToRestore.length) {
    const results = await restore(replacedToRestore.map((a) => request(a.outcome.destPath!)));
    const byPath = new Map(results.map((r) => [r.path, r]));
    for (const action of replacedToRestore) {
      const target = action.outcome.destPath!;
      const result = byPath.get(target);
      if (result?.status === 'restored') {
        outcomes.push({
          sourcePath: target,
          destPath: target,
          outcome: 'moved',
          reason: 'restored the file this run had replaced',
          sizeBytes: null,
        });
      } else {
        outcomes.push({
          sourcePath: target,
          destPath: null,
          outcome: 'skipped',
          reason: `could not bring back the file this run replaced: ${
            result ? describeRestoreFailure(result) : 'no result from the Recycle Bin'
          }`,
          sizeBytes: null,
        });
      }
    }
  }

  // Stage 4: now bin the copies/archives that were set aside.
  for (const { aside, target, label, sizeBytes } of asides) {
    try {
      await trash(aside);
      outcomes.push({ sourcePath: target, destPath: null, outcome: 'deleted', reason: label, sizeBytes });
    } catch (err) {
      // Put it back rather than leave a stray ".fileshuttle-undo-…" file behind.
      try {
        if (!(await pathExists(target))) await fs.promises.rename(aside, target);
      } catch {
        // best effort; the message below tells the user where it is
      }
      outcomes.push({
        sourcePath: target,
        destPath: null,
        outcome: 'error',
        reason: `could not send it to the Recycle Bin: ${errText(err)}`,
        sizeBytes,
      });
    }
  }

  return buildRunResult(startedAt, new Date(), outcomes);
}

/** Moves a moved file back. Returns true when it ended up back at its original path. */
async function undoMoveBack(original: FileOutcome, outcomes: FileOutcome[]): Promise<boolean> {
  const from = original.destPath!;
  const to = original.sourcePath;

  if (!(await pathExists(from))) {
    outcomes.push({
      sourcePath: from,
      destPath: to,
      outcome: 'error',
      reason: 'file no longer exists at its recorded destination',
      sizeBytes: null,
    });
    return false;
  }

  if (await pathExists(to)) {
    outcomes.push({
      sourcePath: from,
      destPath: null,
      outcome: 'skipped',
      reason: 'a file already exists at the original source path',
      sizeBytes: null,
    });
    return false;
  }

  try {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    const size = (await fs.promises.stat(from)).size;
    await renameOrCopyAcrossDevices(from, to);
    outcomes.push({ sourcePath: from, destPath: to, outcome: 'moved', reason: null, sizeBytes: size });
    return true;
  } catch (err) {
    outcomes.push({ sourcePath: from, destPath: to, outcome: 'error', reason: String(err), sizeBytes: null });
    return false;
  }
}

/** Sends something the run created to the Recycle Bin. Returns true if it is now gone. */
async function removeCreated(
  target: string,
  label: string,
  sizeBytes: number | null,
  trash: TrashFn,
  outcomes: FileOutcome[]
): Promise<boolean> {
  if (!(await pathExists(target))) {
    outcomes.push({
      sourcePath: target,
      destPath: null,
      outcome: 'skipped',
      reason: 'already gone',
      sizeBytes: null,
    });
    // Nothing is in the way, so anything it replaced can still be brought back.
    return true;
  }
  try {
    await trash(target);
    outcomes.push({ sourcePath: target, destPath: null, outcome: 'deleted', reason: label, sizeBytes });
    return true;
  } catch (err) {
    outcomes.push({
      sourcePath: target,
      destPath: null,
      outcome: 'error',
      reason: `could not send it to the Recycle Bin: ${errText(err)}`,
      sizeBytes,
    });
    return false;
  }
}
