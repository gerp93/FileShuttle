import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileOutcome, RunResult, StepPreview } from '../../shared/types';
import PreviewDialog, { formatBytes } from './PreviewDialog';

const result = (outcomes: FileOutcome[]): RunResult => {
  const count = (o: FileOutcome['outcome']) => outcomes.filter((f) => f.outcome === o).length;
  return {
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    fileOutcomes: outcomes,
    filesMoved: count('moved'),
    filesCopied: count('copied'),
    filesDeleted: count('deleted'),
    filesSkipped: count('skipped'),
    filesErrored: count('error'),
    filesExtracted: count('extracted'),
    filesZipped: count('zipped'),
  };
};

const step = (outcomes: FileOutcome[], extra: Partial<StepPreview> = {}): StepPreview => ({
  mappingId: 1,
  mappingName: 'Downloads sorter',
  actionType: 'move',
  result: result(outcomes),
  totalOutcomes: outcomes.length,
  truncated: false,
  totalBytes: 0,
  overwriteCount: 0,
  ...extra,
});

const file = (o: Partial<FileOutcome> & Pick<FileOutcome, 'outcome'>): FileOutcome => ({
  sourcePath: 'C:\\in\\a.txt',
  destPath: 'C:\\out\\a.txt',
  reason: null,
  sizeBytes: 10,
  ...o,
});

const render = (props: Partial<Parameters<typeof PreviewDialog>[0]> & { steps: StepPreview[] }) =>
  renderToStaticMarkup(<PreviewDialog title="Preview: test" onClose={() => undefined} {...props} />);

describe('formatBytes', () => {
  it('scales units and keeps sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(250 * 1024 ** 3)).toBe('250 GB');
  });
});

describe('PreviewDialog', () => {
  it('says nothing has been changed and summarises what would happen', () => {
    const html = render({
      steps: [step([file({ outcome: 'moved' }), file({ outcome: 'moved' }), file({ outcome: 'skipped', destPath: null, reason: 'conflict_skip' })], { totalBytes: 20 })],
    });
    expect(html).toContain('Preview only');
    expect(html).toContain('Would move 2 files (20 B)');
    expect(html).toContain('1 left in place');
    expect(html).toContain('already exists at destination');
  });

  it('warns how many existing files would be replaced', () => {
    const html = render({
      steps: [step([file({ outcome: 'moved', reason: 'conflict_overwrite' })], { overwriteCount: 1 })],
    });
    expect(html).toContain('1 file already at the destination would be replaced');
    expect(html).toContain('replaces the existing file');
  });

  it('describes deletes as going to the Recycle Bin', () => {
    const html = render({ steps: [step([file({ outcome: 'deleted', destPath: null })], { actionType: 'delete' })] });
    expect(html).toContain('send 1 file to the Recycle Bin');
  });

  it('shows problems, including the reason, and counts them', () => {
    const html = render({
      steps: [step([file({ outcome: 'error', destPath: null, reason: 'Filter 1 (File size): not a number' })])],
    });
    expect(html).toContain('Nothing to do');
    expect(html).toContain('1 problem');
    expect(html).toContain('Filter 1 (File size): not a number');
  });

  it('reports an empty preview plainly', () => {
    expect(render({ steps: [step([])] })).toContain('Nothing to do');
    expect(render({ steps: [] })).toContain('no enabled mappings');
  });

  it('names each step when previewing a multi-step job, and shows the job note', () => {
    const html = render({
      steps: [step([], { mappingName: 'First' }), step([], { mappingId: 2, mappingName: 'Second' })],
      note: 'later steps depend on earlier ones',
    });
    expect(html).toContain('First');
    expect(html).toContain('Second');
    expect(html).toContain('later steps depend on earlier ones');
  });

  it('does not name the step for a single mapping', () => {
    expect(render({ steps: [step([])] })).not.toContain('Downloads sorter');
  });

  it('tells the user when the list is cut short but the totals are complete', () => {
    const shown = Array.from({ length: 3 }, () => file({ outcome: 'moved' }));
    const html = render({ steps: [step(shown, { truncated: true, totalOutcomes: 5000 })] });
    expect(html).toContain('Showing the first 3 of 5,000 files');
  });

  it('offers a Run button only when asked to', () => {
    const steps = [step([file({ outcome: 'moved' })])];
    expect(render({ steps })).not.toContain('Run Now');
    expect(render({ steps, onRun: () => undefined })).toContain('Run Now');
    expect(render({ steps, onRun: () => undefined, runLabel: 'Go' })).toContain('Go');
  });
});
