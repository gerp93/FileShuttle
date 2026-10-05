import { useState } from 'react';
import { FileOutcome, outcomeReasonLabel, StepPreview } from '../../shared/types';

const VERB: Record<FileOutcome['outcome'], string> = {
  moved: 'MOVE',
  copied: 'COPY',
  deleted: 'DELETE',
  zipped: 'ZIP',
  extracted: 'EXTRACT',
  skipped: 'SKIP',
  error: 'ERROR',
};

const PAGE = 200;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function stepHeadline(step: StepPreview): string {
  const { result } = step;
  const parts: string[] = [];
  if (result.filesMoved) parts.push(`move ${plural(result.filesMoved, 'file')}`);
  if (result.filesCopied) parts.push(`copy ${plural(result.filesCopied, 'file')}`);
  if (result.filesDeleted) parts.push(`send ${plural(result.filesDeleted, 'file')} to the Recycle Bin`);
  if (result.filesZipped) parts.push(`zip ${plural(result.filesZipped, 'item')}`);
  if (result.filesExtracted) parts.push(`extract ${plural(result.filesExtracted, 'archive')}`);
  const acting = parts.length ? `Would ${parts.join(', ')}` : 'Nothing to do';
  const size = step.totalBytes > 0 ? ` (${formatBytes(step.totalBytes)})` : '';
  const extras: string[] = [];
  if (result.filesSkipped) extras.push(`${result.filesSkipped} left in place`);
  if (result.filesErrored) extras.push(`${plural(result.filesErrored, 'problem')}`);
  return `${acting}${size}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
}

function StepSection({ step, showName }: { step: StepPreview; showName: boolean }) {
  const [visible, setVisible] = useState(PAGE);
  const rows = step.result.fileOutcomes;

  return (
    <section className="preview-step">
      {showName && (
        <h4 className="preview-step-title">
          {step.mappingName} <span className="muted">· {step.actionType}</span>
        </h4>
      )}
      <p className={step.result.filesErrored ? 'error-text' : undefined} style={{ margin: '4px 0' }}>
        {stepHeadline(step)}
      </p>
      {step.overwriteCount > 0 && (
        <p className="error-text" style={{ margin: '4px 0' }}>
          ⚠ {plural(step.overwriteCount, 'file')} already at the destination would be replaced.
        </p>
      )}

      {rows.slice(0, visible).map((file, i) => {
        const reason = outcomeReasonLabel(file.reason);
        return (
          <div key={i} className={`run-detail${file.outcome === 'error' ? ' preview-error' : ''}`}>
            {VERB[file.outcome].padEnd(8)} {file.sourcePath}
            {file.destPath ? `  →  ${file.destPath}` : ''}
            {reason ? `  (${reason})` : ''}
            {file.outcome === 'error' && file.reason ? `  ${file.reason}` : ''}
          </div>
        );
      })}

      {rows.length > visible && (
        <button className="text" onClick={() => setVisible(visible + PAGE * 2)}>
          Show more ({rows.length - visible} not shown)
        </button>
      )}
      {step.truncated && rows.length <= visible && (
        <p className="muted">
          Showing the first {rows.length.toLocaleString()} of {step.totalOutcomes.toLocaleString()} files. The totals above
          include all of them.
        </p>
      )}
    </section>
  );
}

interface Props {
  title: string;
  steps: StepPreview[];
  /** Shown above the list; used to flag that later job steps depend on earlier ones. */
  note?: string;
  onClose: () => void;
  /** When provided, the dialog offers to run straight after reviewing. */
  onRun?: () => void;
  runLabel?: string;
}

export default function PreviewDialog({ title, steps, note, onClose, onRun, runLabel = 'Run Now' }: Props) {
  const totalErrors = steps.reduce((sum, step) => sum + step.result.filesErrored, 0);

  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-wide">
        <h3>{title}</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Preview only — nothing has been changed.
        </p>
        {note && <p className="muted">{note}</p>}

        <div className="preview-body">
          {steps.length === 0 ? (
            <p>There are no enabled mappings to preview.</p>
          ) : (
            steps.map((step, i) => <StepSection key={`${step.mappingId}-${i}`} step={step} showName={steps.length > 1} />)
          )}
        </div>

        <div className="dialog-actions">
          <button className="outline" onClick={onClose}>Close</button>
          {onRun && (
            <button
              className={totalErrors ? 'outline' : 'primary'}
              onClick={onRun}
              disabled={steps.length === 0}
              title={totalErrors ? 'Some files had problems in the preview' : undefined}
            >
              {runLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
