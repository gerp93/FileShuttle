import { useEffect, useState } from 'react';
import { FileOutcome, MappingRecord, RunSummary } from '../../shared/types';

const STATUS_CLASS: Record<string, string> = {
  success: 'status-success',
  partial: 'status-partial',
  error: 'status-error',
};

function runMovedFiles(run: RunSummary): boolean {
  return run.filesMoved + run.filesCopied + run.filesDeleted > 0;
}

function actionSummary(run: RunSummary, actionType: string | null): string {
  if (actionType === 'copy') return `copied ${run.filesCopied}`;
  if (actionType === 'delete') return `deleted ${run.filesDeleted}`;
  if (actionType === 'move') return `moved ${run.filesMoved}`;
  if (run.filesDeleted) return `deleted ${run.filesDeleted}`;
  if (run.filesCopied) return `copied ${run.filesCopied}`;
  return `moved ${run.filesMoved}`;
}

export default function History() {
  const [mappings, setMappings] = useState<MappingRecord[]>([]);
  const [filterId, setFilterId] = useState<string>('all');
  const [showEmpty, setShowEmpty] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [expanded, setExpanded] = useState<Record<number, FileOutcome[]>>({});
  const [openRuns, setOpenRuns] = useState<Set<number>>(new Set());
  const [confirmUndo, setConfirmUndo] = useState<RunSummary | null>(null);
  const [snackbar, setSnackbar] = useState('');

  const load = async () => {
    const mappingId = filterId === 'all' ? null : parseInt(filterId, 10);
    let list = await window.fileshuttleAPI.history.list(mappingId);
    if (!showEmpty) list = list.filter(runMovedFiles);
    setRuns(list);
  };

  useEffect(() => {
    void window.fileshuttleAPI.mappings.list().then(setMappings);
  }, []);

  useEffect(() => {
    void load();
  }, [filterId, showEmpty]);

  const toggleRun = async (run: RunSummary) => {
    const next = new Set(openRuns);
    if (next.has(run.id)) {
      next.delete(run.id);
    } else {
      next.add(run.id);
      if (!expanded[run.id]) {
        const detail = await window.fileshuttleAPI.history.getDetail(run.id);
        setExpanded({ ...expanded, [run.id]: detail });
      }
    }
    setOpenRuns(next);
  };

  const doUndo = async (run: RunSummary) => {
    setConfirmUndo(null);
    const result = await window.fileshuttleAPI.history.undo(run.id);
    setSnackbar(`Undo finished: moved back ${result.filesMoved}, skipped ${result.filesSkipped}, errored ${result.filesErrored}.`);
    await load();
  };

  return (
    <div>
      <h1 className="page-title">History</h1>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <label className="field">
          Mapping
          <select value={filterId} onChange={(e) => setFilterId(e.target.value)}>
            <option value="all">All mappings</option>
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label className="switch-row">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          Show runs with no files moved
        </label>
      </div>

      {!runs.length ? (
        <div className="empty-state">
          {showEmpty ? 'No runs yet.' : 'No runs with moved files yet.'}
        </div>
      ) : (
        runs.map((run) => {
          const mapping = mappings.find((m) => m.id === run.mappingId);
          const isOpen = openRuns.has(run.id);
          return (
            <div key={run.id} className="card">
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <button className="text" onClick={() => void toggleRun(run)} style={{ padding: 0 }}>
                  {isOpen ? '▲' : '▼'}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className={`badge ${STATUS_CLASS[run.status] ?? ''}`}>{run.status.toUpperCase()}</span>
                    <strong>{run.mappingNameSnapshot}</strong>
                  </div>
                  <div className="muted">
                    ({run.triggerType}{run.triggeredByRunId ? ', chained' : ''}) · {run.startedAt} ·{' '}
                    {actionSummary(run, mapping?.actionType ?? null)} / skipped {run.filesSkipped} / errored {run.filesErrored}
                  </div>
                  {isOpen && (
                    <div style={{ marginTop: 8 }}>
                      {(expanded[run.id] ?? []).length === 0 ? (
                        <p className="muted">No file detail recorded for this run.</p>
                      ) : (
                        (expanded[run.id] ?? []).map((d, i) => (
                          <div key={i} className="run-detail">
                            {d.outcome.toUpperCase().padEnd(8)} {d.sourcePath}
                            {d.destPath ? `  →  ${d.destPath}` : ''}
                            {d.reason ? `  (${d.reason})` : ''}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <div>
                  {mapping && (
                    <>
                      <button className="text" title={mapping.sourcePath} onClick={() => void window.fileshuttleAPI.shell.openPath(mapping.sourcePath)}>📂</button>
                      {mapping.actionType !== 'delete' && (
                        <button className="text" title={mapping.destPath} onClick={() => void window.fileshuttleAPI.shell.openPath(mapping.destPath)}>📁</button>
                      )}
                    </>
                  )}
                  {run.undoneByRunId ? (
                    <span className="muted">Undone</span>
                  ) : run.filesMoved > 0 ? (
                    <button className="text" onClick={() => setConfirmUndo(run)}>Undo</button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })
      )}

      {confirmUndo && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Undo this run?</h3>
            <p>
              This will move {confirmUndo.filesMoved} file(s) back to where
              &quot;{confirmUndo.mappingNameSnapshot}&quot; originally moved them from.
            </p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmUndo(null)}>Cancel</button>
              <button className="primary" onClick={() => void doUndo(confirmUndo)}>Undo</button>
            </div>
          </div>
        </div>
      )}

      {snackbar && (
        <div className="snackbar" onClick={() => setSnackbar('')}>{snackbar}</div>
      )}
    </div>
  );
}
