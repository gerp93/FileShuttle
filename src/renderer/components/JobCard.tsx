import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { JobRecord, RunStats } from '../../shared/types';

function scheduleSummary(record: JobRecord): string {
  if (record.scheduleType === 'interval') return `Every ${record.scheduleIntervalMinutes} min`;
  if (record.scheduleType === 'daily_at') return `Daily at ${record.scheduleDailyTime}`;
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

  useEffect(() => {
    void window.fileshuttleAPI.jobs.getStats(record.id).then(setStats);
  }, [record.id]);

  const statsLine = () => {
    if (!stats) return '';
    if (!stats.lastRun) return `Never run   ·   ${stats.runCount} run${stats.runCount !== 1 ? 's' : ''} total`;
    const last = stats.lastRun;
    const runLabel = `${stats.runCount} run${stats.runCount !== 1 ? 's' : ''} total`;
    return `Last run ${relativeTime(last.startedAt)} — moved ${last.filesMoved}, copied ${last.filesCopied}, deleted ${last.filesDeleted}, skipped ${last.filesSkipped}, errored ${last.filesErrored}   ·   ${runLabel}`;
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const result = await window.fileshuttleAPI.jobs.run(record.id);
      setStatus(
        `Moved ${result.filesMoved}, copied ${result.filesCopied}, deleted ${result.filesDeleted}, skipped ${result.filesSkipped}, errored ${result.filesErrored}`
      );
      setStats(await window.fileshuttleAPI.jobs.getStats(record.id));
    } catch (err) {
      setStatus(`Run failed: ${String(err)}`);
    } finally {
      setRunning(false);
    }
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
              {i + 1}. {step.name}
              {step.actionType === 'delete' ? ' — delete' : step.actionType === 'copy' ? ' — copy' : ' — move'}
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
      {status && <p className="muted">{status}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <button className="primary" onClick={() => void runNow()} disabled={running || record.steps.length === 0}>
          {running ? 'Running...' : 'Run Now'}
        </button>
        <div>
          <button className="text" onClick={() => navigate(`/jobs/${record.id}`)}>Edit</button>
          <button className="text danger" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      </div>

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
