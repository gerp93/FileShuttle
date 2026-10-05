import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isDestructiveMapping, JobPreview, JobRecord, RunProgressEvent, RunStats } from '../../shared/types';
import { errorMessage } from '../utils/errors';
import PreviewDialog from './PreviewDialog';

function scheduleSummary(record: JobRecord): string {
  if (record.scheduleType === 'interval') return `Every ${record.scheduleIntervalMinutes} min`;
  if (record.scheduleType === 'daily_at') return `Daily at ${record.scheduleDailyTime}`;
  if (record.scheduleType === 'watch') return 'Watching for new files';
  return 'Manual only';
}

function relativeTime(iso: string): string {
  const when = new Date(iso);
  const seconds = (Date.now() - when.getTime()) / 1000;
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} hr ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)} day${days >= 2 ? 's' : ''} ago`;
  return when.toISOString().slice(0, 10);
}

function progressLine(p: RunProgressEvent): string {
  if (p.phase === 'queued') return 'Waiting for another job to finish…';
  const step = p.stepCount > 1 ? `Step ${p.stepIndex} of ${p.stepCount} (${p.stepName}) · ` : '';
  if (p.phase === 'scanning' || p.total == null) return `${step}Scanning… ${p.scanned.toLocaleString()} files found`;
  return `${step}${p.processed.toLocaleString()} of ${p.total.toLocaleString()} files`;
}

interface Props {
  record: JobRecord;
  onChanged: () => void;
}

export default function JobCard({ record, onChanged }: Props) {
  const navigate = useNavigate();
  const [stats, setStats] = useState<RunStats | null>(null);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<JobPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmFirstRun, setConfirmFirstRun] = useState(false);
  // Live progress for this job, whether the run was started here, by a schedule, or by the folder watcher.
  const [progress, setProgress] = useState<RunProgressEvent | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    void window.fileshuttleAPI.jobs.getStats(record.id).then(setStats);
  }, [record.id]);

  useEffect(() => {
    void window.fileshuttleAPI.jobs.getActive().then((active) => {
      setProgress(active.find((event) => event.jobId === record.id) ?? null);
    });
    return window.fileshuttleAPI.jobs.onProgress((event) => {
      if (event.jobId !== record.id) return;
      if (event.phase === 'finished') {
        setProgress(null);
        setCancelling(false);
        // A run that this card didn't start (schedule, watcher) still changes its stats.
        void window.fileshuttleAPI.jobs.getStats(record.id).then(setStats);
      } else {
        setProgress(event);
      }
    });
  }, [record.id]);

  const busy = running || progress !== null;

  const hasDestructiveStep = record.steps.some((step) => step.enabled && isDestructiveMapping(step));

  const statsLine = () => {
    if (!stats) return '';
    if (!stats.lastRun) return `Never run   ·   ${stats.runCount} run${stats.runCount !== 1 ? 's' : ''} total`;
    const last = stats.lastRun;
    const runLabel = `${stats.runCount} run${stats.runCount !== 1 ? 's' : ''} total`;
    return `Last run ${relativeTime(last.startedAt)} — moved ${last.filesMoved}, copied ${last.filesCopied}, deleted ${last.filesDeleted}, zipped ${last.filesZipped}, extracted ${last.filesExtracted}, skipped ${last.filesSkipped}, errored ${last.filesErrored}   ·   ${runLabel}`;
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const result = await window.fileshuttleAPI.jobs.run(record.id);
      setStatus(
        (result.cancelled ? 'Cancelled — ' : '') +
          `Moved ${result.filesMoved}, copied ${result.filesCopied}, deleted ${result.filesDeleted}, zipped ${result.filesZipped}, extracted ${result.filesExtracted}, skipped ${result.filesSkipped}, errored ${result.filesErrored}`
      );
      setStats(await window.fileshuttleAPI.jobs.getStats(record.id));
    } catch (err) {
      setStatus(`Run failed: ${errorMessage(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const cancelRun = async () => {
    setCancelling(true);
    await window.fileshuttleAPI.jobs.cancel(record.id);
  };

  const openPreview = async () => {
    setConfirmFirstRun(false);
    setPreviewing(true);
    try {
      setPreview(await window.fileshuttleAPI.jobs.preview(record.id));
    } catch (err) {
      setStatus(`Preview failed: ${errorMessage(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  // A job that deletes or overwrites and has never run is the riskiest first
  // click there is -- offer a look at what it would do before it does it.
  const requestRun = () => {
    if (hasDestructiveStep && stats && stats.runCount === 0) {
      setConfirmFirstRun(true);
      return;
    }
    void runNow();
  };

  const toggleEnabled = async (enabled: boolean) => {
    await window.fileshuttleAPI.jobs.setEnabled(record.id, enabled);
    onChanged();
  };

  const doDelete = async () => {
    await window.fileshuttleAPI.jobs.delete(record.id);
    setConfirmDelete(false);
    onChanged();
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="card-title" style={{ flex: 1 }}>{record.name}</span>
        <span className="muted">{record.enabled ? 'Enabled' : 'Disabled'}</span>
        <input type="checkbox" checked={record.enabled} onChange={(e) => void toggleEnabled(e.target.checked)} />
      </div>

      <div className="muted" style={{ marginBottom: 8 }}>
        {record.steps.length === 0 ? (
          <div>No mappings in this job yet.</div>
        ) : (
          record.steps.map((step, i) => (
            <div key={`${step.id}-${i}`}>
              {i + 1}. {step.name} — {step.actionType}
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <span className="badge">⏱ {scheduleSummary(record)}</span>
        <span className="badge">
          {record.steps.length} mapping{record.steps.length !== 1 ? 's' : ''}
        </span>
      </div>

      <p className="muted">{statsLine()}</p>
      {progress && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="muted" style={{ flex: 1 }}>{progressLine(progress)}</span>
            <button className="text danger" onClick={() => void cancelRun()} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
          {progress.phase === 'processing' && progress.total != null && progress.total > 0 && (
            <progress value={progress.processed} max={progress.total} style={{ width: '100%' }} />
          )}
        </div>
      )}
      {status && <p className="muted">{status}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={requestRun} disabled={busy || record.steps.length === 0}>
            {busy ? 'Running...' : 'Run Now'}
          </button>
          <button
            className="outline"
            onClick={() => void openPreview()}
            disabled={busy || previewing || record.steps.length === 0}
            title="See what this job would do, without changing anything"
          >
            {previewing ? 'Checking...' : 'Preview'}
          </button>
        </div>
        <div>
          <button className="text" onClick={() => navigate(`/jobs/${record.id}`)}>Edit</button>
          <button className="text danger" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      </div>

      {preview && (
        <PreviewDialog
          title={`Preview: ${record.name}`}
          steps={preview.steps}
          note={
            preview.steps.length > 1
              ? 'Each step is shown against the folders as they are right now. A step that works on files an earlier step produces may handle more on a real run.'
              : undefined
          }
          onClose={() => setPreview(null)}
          onRun={() => {
            setPreview(null);
            void runNow();
          }}
        />
      )}

      {confirmFirstRun && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Preview this job first?</h3>
            <p>
              &quot;{record.name}&quot; deletes or overwrites files and hasn&apos;t been run before.
              A preview shows exactly which files it would touch, without changing anything.
            </p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmFirstRun(false)}>Cancel</button>
              <button
                className="outline"
                onClick={() => {
                  setConfirmFirstRun(false);
                  void runNow();
                }}
              >
                Run anyway
              </button>
              <button className="primary" onClick={() => void openPreview()}>Preview first</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Delete job?</h3>
            <p>
              &quot;{record.name}&quot; will be deleted. Mappings in it are not deleted and can be reused in other jobs.
            </p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="primary" onClick={() => void doDelete()}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
