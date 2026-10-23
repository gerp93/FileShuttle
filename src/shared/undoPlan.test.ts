import { describe, expect, it } from 'vitest';
import type { FileOutcome } from './types';
import { describeUndo, planUndo, summarizeUndoPlan } from './undoPlan';

const outcome = (o: Partial<FileOutcome> & Pick<FileOutcome, 'outcome'>): FileOutcome => ({
  sourcePath: '/src/a.txt',
  destPath: '/dest/a.txt',
  reason: null,
  sizeBytes: 1,
  ...o,
});

describe('planUndo', () => {
  it('maps each outcome kind to its reversal', () => {
    const plan = planUndo(
      [
        outcome({ outcome: 'moved' }),
        outcome({ outcome: 'copied' }),
        outcome({ outcome: 'zipped' }),
        outcome({ outcome: 'extracted' }),
        outcome({ outcome: 'deleted', destPath: null }),
        outcome({ outcome: 'skipped' }),
        outcome({ outcome: 'error' }),
      ],
      false
    );
    expect(plan.actions.map((a) => a.kind)).toEqual([
      'move_back',
      'remove_copy',
      'remove_archive',
      'remove_extracted',
      'restore_deleted',
    ]);
    expect(plan.notUndoable).toEqual([]);
  });

  it('flags outcomes that replaced a file so the replaced file is restored too', () => {
    const plan = planUndo([outcome({ outcome: 'moved', reason: 'conflict_overwrite' })], false);
    expect(plan.actions[0].restoreReplaced).toBe(true);
  });

  it('refuses to undo an unzip that merged into an existing folder', () => {
    const plan = planUndo([outcome({ outcome: 'extracted', reason: 'conflict_overwrite' })], false);
    expect(plan.actions).toEqual([]);
    expect(plan.notUndoable).toHaveLength(1);
  });

  it('only reverses moves when the run is itself an undo', () => {
    const plan = planUndo(
      [
        outcome({ outcome: 'moved', sourcePath: '/dest/a.txt', destPath: '/src/a.txt' }),
        outcome({ outcome: 'deleted', destPath: null }),
        outcome({ outcome: 'moved', sourcePath: '/same.txt', destPath: '/same.txt', reason: 'restored from the Recycle Bin' }),
      ],
      true
    );
    expect(plan.actions.map((a) => a.kind)).toEqual(['move_back']);
  });

  it('ignores outcomes with no destination to act on', () => {
    expect(planUndo([outcome({ outcome: 'moved', destPath: null })], false).actions).toEqual([]);
  });
});

describe('describeUndo', () => {
  it('lists only what will actually happen, with correct plurals', () => {
    const summary = summarizeUndoPlan(
      planUndo(
        [
          outcome({ outcome: 'moved' }),
          outcome({ outcome: 'moved', sourcePath: '/b' }),
          outcome({ outcome: 'deleted', destPath: null }),
          outcome({ outcome: 'copied', reason: 'conflict_overwrite' }),
        ],
        false
      )
    );
    expect(describeUndo(summary)).toEqual([
      'Move 2 files back to where they came from',
      'Send 1 file (the copies) to the Recycle Bin',
      'Restore 1 file from the Recycle Bin',
      'Bring back 1 file that this run replaced (from the Recycle Bin)',
    ]);
  });

  it('is empty when nothing can be undone', () => {
    expect(describeUndo(summarizeUndoPlan(planUndo([outcome({ outcome: 'skipped' })], false)))).toEqual([]);
  });
});
