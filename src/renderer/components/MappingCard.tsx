import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MappingRecord, RunStats } from '../../shared/types';

const CONFLICT_LABELS: Record<string, string> = {
  skip: 'Skip duplicates',
  overwrite: 'Overwrite duplicates',
  auto_rename: 'Keep both (rename)',
};

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

function accomplished(run: { filesMoved: number; filesCopied: number; filesDeleted: number }, actionType: string): number {
  if (actionType === 'copy') return run.filesCopied;
  if (actionType === 'delete') return run.filesDeleted;
  return run.filesMoved;
}

interface Props {
  record: MappingRecord;
  onChanged: () => void;
}

export default function MappingCard({ record, onChanged }: Props) {
  const navigate = useNavigate();
  const [stats, setStats] = useState<RunStats | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void window.fileshuttleAPI.mappings.getStats(record.id).then(setStats);
  }, [record.id]);

  const statsLine = () => {
    if (!stats) return '';
    const label = record.actionType === 'copy' ? 'copied' : record.actionType === 'delete' ? 'deleted' : 'moved';
    if (!stats.lastRun) return `Never run   ·   ${stats.runCount} run${stats.runCount !== 1 ? 's' : ''} total`;
    const last = stats.lastRun;
    const count = accomplished(last, record.actionType);
    const runLabel = `${stats.runCount} run${stats.runCount !== 1 ? 's' : ''} total`;
    return `Last run ${relativeTime(last.startedAt)} — ${label} ${count}, skipped ${last.filesSkipped}, errored ${last.filesErrored}   ·   ${runLabel}`;
  };

  const toggleEnabled = async (enabled: boolean) => {
    await window.fileshuttleAPI.mappings.setEnabled(record.id, enabled);
    onChanged();
  };

  const doDelete = async () => {
    await window.fileshuttleAPI.mappings.delete(record.id);
    setConfirmDelete(false);
    onChanged();
  };

  const pathParts = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="card-title" style={{ flex: 1 }}>{record.name}</span>
        <span className="muted">{record.enabled ? 'Enabled' : 'Disabled'}</span>
        <input type="checkbox" checked={record.enabled} onChange={(e) => void toggleEnabled(e.target.checked)} />
      </div>

      <div className="muted" style={{ marginBottom: 8 }}>
        <div>From: {pathParts(record.sourcePath).map((part, i) => (
          <span key={i}><span className="path-chip">{part}</span>{i < pathParts(record.sourcePath).length - 1 ? ' › ' : ''}</span>
        ))}</div>
        {record.actionType === 'delete' ? (
          <div style={{ color: 'var(--color-accent-red)' }}>Delete matching files (Recycle Bin)</div>
        ) : (
          <div>To: {pathParts(record.destPath).map((part, i) => (
            <span key={i}><span className="path-chip">{part}</span>{i < pathParts(record.destPath).length - 1 ? ' › ' : ''}</span>
          ))}</div>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        <span className="badge">{record.actionType}</span>
        {record.actionType !== 'delete' && (
          <span className="badge">{CONFLICT_LABELS[record.conflictPolicy] ?? record.conflictPolicy}</span>
        )}
        {record.filters.length ? (
          <span className="badge">{record.filters.length} filter{record.filters.length !== 1 ? 's' : ''} · match {record.filterMatchMode === 'all' ? 'ALL' : 'ANY'}</span>
        ) : (
          <span className="badge">All files</span>
        )}
        {record.keepNewest != null && record.actionType !== 'copy' && (
          <span className="badge">Keep newest {record.keepNewest}</span>
        )}
      </div>

      <p className="muted">{statsLine()}</p>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="text" onClick={() => navigate(`/editor/${record.id}`)}>Edit</button>
        <button className="text danger" onClick={() => setConfirmDelete(true)}>Delete</button>
      </div>

      {confirmDelete && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Delete mapping?</h3>
            <p>
              &quot;{record.name}&quot; and its run history will be permanently deleted. Jobs that use this mapping
              will drop this step.
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
