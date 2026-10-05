import type { FileOutcome } from './types';

/**
 * What undoing a run means, per file. Shared so the History dialog can say
 * exactly what will happen before the user clicks, and the engine does the same
 * thing it said it would.
 *
 *   moved      -> move it back to where it came from
 *   copied     -> send the copy to the Recycle Bin (originals were never touched)
 *   zipped     -> send the archive that was created to the Recycle Bin
 *   extracted  -> restore the original .zip from the Recycle Bin, then send the
 *                 extracted folder there (only if the folder was entirely new)
 *   deleted    -> restore the file from the Recycle Bin
 *
 * Whenever the run replaced an existing file ("overwrite"), undo also tries to
 * restore the replaced file from the Recycle Bin.
 */
export type UndoActionKind = 'move_back' | 'remove_copy' | 'remove_archive' | 'remove_extracted' | 'restore_deleted';

export interface UndoAction {
  kind: UndoActionKind;
  outcome: FileOutcome;
  /** The run replaced a file at the destination; try to bring that file back afterwards. */
  restoreReplaced: boolean;
}

export interface UndoPlan {
  actions: UndoAction[];
  /** Outcomes that cannot be undone automatically, with the reason. */
  notUndoable: { outcome: FileOutcome; reason: string }[];
}

export function planUndo(fileOutcomes: FileOutcome[], originalWasUndo: boolean): UndoPlan {
  const actions: UndoAction[] = [];
  const notUndoable: UndoPlan['notUndoable'] = [];

  for (const outcome of fileOutcomes) {
    const replaced = outcome.reason === 'conflict_overwrite';

    // An undo run only ever records moves back (and a few removals/restores).
    // Reversing it again is limited to the moves, so "redo" stays predictable.
    if (originalWasUndo) {
      if (outcome.outcome === 'moved' && outcome.destPath && outcome.destPath !== outcome.sourcePath) {
        actions.push({ kind: 'move_back', outcome, restoreReplaced: false });
      }
      continue;
    }

    switch (outcome.outcome) {
      case 'moved':
        if (outcome.destPath) actions.push({ kind: 'move_back', outcome, restoreReplaced: replaced });
        break;
      case 'copied':
        if (outcome.destPath) actions.push({ kind: 'remove_copy', outcome, restoreReplaced: replaced });
        break;
      case 'zipped':
        if (outcome.destPath) actions.push({ kind: 'remove_archive', outcome, restoreReplaced: replaced });
        break;
      case 'extracted':
        if (!outcome.destPath) break;
        if (replaced) {
          // Extracted on top of a folder that already existed: we don't know which
          // files in it are ours, so removing the folder could take the user's own.
          notUndoable.push({
            outcome,
            reason: 'extracted into a folder that already existed, so its files can’t be told apart from yours',
          });
        } else {
          actions.push({ kind: 'remove_extracted', outcome, restoreReplaced: false });
        }
        break;
      case 'deleted':
        actions.push({ kind: 'restore_deleted', outcome, restoreReplaced: false });
        break;
      default:
        break;
    }
  }

  return { actions, notUndoable };
}

export interface UndoSummary {
  moveBack: number;
  removeCopies: number;
  removeArchives: number;
  removeExtracted: number;
  restoreDeleted: number;
  restoreReplaced: number;
  notUndoable: number;
}

export function summarizeUndoPlan(plan: UndoPlan): UndoSummary {
  const count = (kind: UndoActionKind) => plan.actions.filter((a) => a.kind === kind).length;
  return {
    moveBack: count('move_back'),
    removeCopies: count('remove_copy'),
    removeArchives: count('remove_archive'),
    removeExtracted: count('remove_extracted'),
    restoreDeleted: count('restore_deleted'),
    restoreReplaced: plan.actions.filter((a) => a.restoreReplaced).length,
    notUndoable: plan.notUndoable.length,
  };
}

/** Plain-language bullet lines for the confirmation dialog. */
export function describeUndo(summary: UndoSummary): string[] {
  const lines: string[] = [];
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  if (summary.moveBack) lines.push(`Move ${files(summary.moveBack)} back to where they came from`);
  if (summary.removeCopies) lines.push(`Send ${files(summary.removeCopies)} (the copies) to the Recycle Bin`);
  if (summary.removeArchives) {
    lines.push(`Send ${summary.removeArchives} zip archive${summary.removeArchives === 1 ? '' : 's'} that were created to the Recycle Bin`);
  }
  if (summary.removeExtracted) {
    lines.push(
      `Restore ${summary.removeExtracted} original zip file${summary.removeExtracted === 1 ? '' : 's'} from the Recycle Bin and send the extracted folder${summary.removeExtracted === 1 ? '' : 's'} there`
    );
  }
  if (summary.restoreDeleted) lines.push(`Restore ${files(summary.restoreDeleted)} from the Recycle Bin`);
  if (summary.restoreReplaced) {
    lines.push(`Bring back ${files(summary.restoreReplaced)} that this run replaced (from the Recycle Bin)`);
  }
  return lines;
}
