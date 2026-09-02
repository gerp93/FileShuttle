import { useEffect, useState } from 'react';
import {
  computeRunStatus,
  FileOutcome,
  MappingRecord,
  RUN_STATUSES,
  RunStatus,
  runStatusClass,
  runStatusLabel,
  runStatusMeaning,
  RunSummary,
} from '../../shared/types';

type Counts = Pick<
  RunSummary,
  'filesMoved' | 'filesCopied' | 'filesDeleted' | 'filesSkipped' | 'filesErrored' | 'filesExtracted' | 'filesZipped'
>;

interface JobHistoryGroup {
  kind: 'job';
  rootId: number;
  jobName: string;
  triggerType: RunSummary['triggerType'];
  startedAt: string;
  finishedAt: string;
  status: RunSummary['status'];
  totals: Counts;
  steps: RunSummary[];
}

interface StandaloneHistoryEntry {
  kind: 'standalone';
  run: RunSummary;
}

type HistoryEntry = JobHistoryGroup | StandaloneHistoryEntry;

function runMovedFiles(run: Counts): boolean {
  return run.filesMoved + run.filesCopied + run.filesDeleted + run.filesExtracted + run.filesZipped > 0;
}

function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'kept_newest') return 'kept (newest)';
  return reason;
}

function actionSummary(run: Counts, actionType: string | null): string {
  if (actionType === 'copy') return `copied ${run.filesCopied}`;
  if (actionType === 'delete') return `deleted ${run.filesDeleted}`;
  if (actionType === 'zip') return `zipped ${run.filesZipped}`;
  if (actionType === 'unzip') return `extracted ${run.filesExtracted}`;
  if (actionType === 'move') return `moved ${run.filesMoved}`;
  if (run.filesDeleted) return `deleted ${run.filesDeleted}`;
  if (run.filesCopied) return `copied ${run.filesCopied}`;
  if (run.filesZipped) return `zipped ${run.filesZipped}`;
  if (run.filesExtracted) return `extracted ${run.filesExtracted}`;
  return `moved ${run.filesMoved}`;
}

function StatusBadge({ counts }: { counts: Counts }) {
  const status = computeRunStatus(counts);
  return <span className={`badge ${runStatusClass(status)}`}>{runStatusLabel(status)}</span>;
}

function totalsSummary(run: Counts): string {
  const parts: string[] = [];
  if (run.filesMoved) parts.push(`moved ${run.filesMoved}`);
  if (run.filesCopied) parts.push(`copied ${run.filesCopied}`);
  if (run.filesDeleted) parts.push(`deleted ${run.filesDeleted}`);
  if (run.filesZipped) parts.push(`zipped ${run.filesZipped}`);
  if (run.filesExtracted) parts.push(`extracted ${run.filesExtracted}`);
  if (!parts.length) parts.push('moved 0');
  return `${parts.join(', ')} / skipped ${run.filesSkipped} / errored ${run.filesErrored}`;
}

function entryStatus(entry: HistoryEntry): RunStatus {
  return computeRunStatus(entry.kind === 'job' ? entry.totals : entry.run);
}

function sumCounts(runs: RunSummary[]): Counts {
  return {
    filesMoved: runs.reduce((sum, run) => sum + run.filesMoved, 0),
    filesCopied: runs.reduce((sum, run) => sum + run.filesCopied, 0),
    filesDeleted: runs.reduce((sum, run) => sum + run.filesDeleted, 0),
    filesSkipped: runs.reduce((sum, run) => sum + run.filesSkipped, 0),
    filesErrored: runs.reduce((sum, run) => sum + run.filesErrored, 0),
    filesExtracted: runs.reduce((sum, run) => sum + run.filesExtracted, 0),
    filesZipped: runs.reduce((sum, run) => sum + run.filesZipped, 0),
  };
}

function groupHistory(runs: RunSummary[]): HistoryEntry[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const used = new Set<number>();
  const children = new Map<number, RunSummary[]>();

  for (const run of runs) {
    if (run.triggeredByRunId != null && byId.has(run.triggeredByRunId)) {
      const siblings = children.get(run.triggeredByRunId) ?? [];
      siblings.push(run);
      children.set(run.triggeredByRunId, siblings);
    }
  }

  const findRoot = (run: RunSummary): RunSummary => {
    let current = run;
    const seen = new Set<number>();
    while (
      current.triggeredByRunId != null &&
      byId.has(current.triggeredByRunId) &&
      !seen.has(current.id)
    ) {
      seen.add(current.id);
      current = byId.get(current.triggeredByRunId)!;
    }
    return current;
  };

  const collectChain = (root: RunSummary): RunSummary[] => {
    const chain = [root];
    used.add(root.id);
    let currentId = root.id;
    while (true) {
      const next = (children.get(currentId) ?? []).find((run) => !used.has(run.id));
      if (!next) break;
      chain.push(next);
      used.add(next.id);
      currentId = next.id;
    }
    return chain;
  };

  const entries: HistoryEntry[] = [];
  for (const run of runs) {
    if (used.has(run.id)) continue;

    if (run.triggerType === 'system' || run.triggerType === 'undo' || run.jobId == null) {
      used.add(run.id);
      entries.push({ kind: 'standalone', run });
      continue;
    }

    const chain = collectChain(findRoot(run));
    const totals = sumCounts(chain);
    entries.push({
      kind: 'job',
      rootId: chain[0].id,
      jobName: chain[0].jobNameSnapshot ?? 'Job',
      triggerType: chain[0].triggerType,
      startedAt: chain[0].startedAt,
      finishedAt: chain[chain.length - 1].finishedAt,
      status: computeRunStatus(totals),
      totals,
      steps: chain,
    });
  }

  return entries;
}

function PathLines({ mapping }: { mapping: MappingRecord | undefined }) {
  if (!mapping) return null;
  return (
    <div className="history-paths">
      <button
        type="button"
        className="history-path"
        title={`Open ${mapping.sourcePath}`}
        onClick={() => void window.fileshuttleAPI.shell.openPath(mapping.sourcePath)}
      >
        <span className="muted">From</span>
        <span>{mapping.sourcePath}</span>
      </button>
      {mapping.actionType !== 'delete' && (
        <button
          type="button"
          className="history-path"
          title={`Open ${mapping.destPath}`}
          onClick={() => void window.fileshuttleAPI.shell.openPath(mapping.destPath)}
        >
          <span className="muted">To</span>
          <span>{mapping.destPath}</span>
        </button>
      )}
    </div>
  );
}

function FileDetails({ expanded }: { expanded: FileOutcome[] | undefined }) {
  if (expanded === undefined) return <p className="muted">Loading file detail…</p>;
  if (expanded.length === 0) return <p className="muted">No file detail recorded for this run.</p>;
  return (
    <div style={{ marginTop: 8 }}>
      {expanded.map((detail, i) => (
        <div key={i} className="run-detail">
          {detail.outcome.toUpperCase().padEnd(8)} {detail.sourcePath}
          {detail.destPath ? `  →  ${detail.destPath}` : ''}
          {reasonLabel(detail.reason) ? `  (${reasonLabel(detail.reason)})` : ''}
        </div>
      ))}
    </div>
  );
}

function MappingRunRow({
  run,
  mapping,
  isOpen,
  expanded,
  onToggle,
  onUndo,
}: {
  run: RunSummary;
  mapping: MappingRecord | undefined;
  isOpen: boolean;
  expanded: FileOutcome[] | undefined;
  onToggle: () => void;
  onUndo: () => void;
}) {
  const isSystem = run.triggerType === 'system';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <button className="text" onClick={onToggle} style={{ padding: 0 }}>
        {isOpen ? '▲' : '▼'}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusBadge counts={run} />
          <strong>{run.mappingNameSnapshot}</strong>
        </div>
        <div className="muted">
          {isSystem ? (
            <>
              (system) · {run.startedAt} → {run.finishedAt}
              {run.errorMessage ? ` · ${run.errorMessage}` : ''}
            </>
          ) : (
            <>
              ({run.triggerType}{run.triggeredByRunId ? ', job step' : ''}
              {run.jobNameSnapshot && !run.triggeredByRunId && run.triggerType === 'undo' ? ', job' : ''})
              {' · '}{run.startedAt} → {run.finishedAt}
              {' · '}{actionSummary(run, mapping?.actionType ?? null)} / skipped {run.filesSkipped} / errored {run.filesErrored}
            </>
          )}
        </div>
        {!isSystem && <PathLines mapping={mapping} />}
        {isOpen && <FileDetails expanded={expanded} />}
      </div>
      <div>
        {isSystem ? null : run.undoneByRunId ? (
          <span className="muted">Undone</span>
        ) : run.filesMoved > 0 ? (
          <button className="text" onClick={onUndo}>Undo</button>
        ) : null}
      </div>
    </div>
  );
}

export default function History() {
  const [mappings, setMappings] = useState<MappingRecord[]>([]);
  const [jobs, setJobs] = useState<{ id: number; name: string }[]>([]);
  const [filterKind, setFilterKind] = useState<'all' | 'job' | 'mapping'>('all');
  const [filterId, setFilterId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | RunStatus>('all');
  const [showEmpty, setShowEmpty] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<number, FileOutcome[]>>({});
  const [openRuns, setOpenRuns] = useState<Set<number>>(new Set());
  const [openJobs, setOpenJobs] = useState<Set<number>>(new Set());
  const [confirmUndo, setConfirmUndo] = useState<RunSummary | null>(null);
  const [snackbar, setSnackbar] = useState('');

  const load = async () => {
    let list: RunSummary[];
    if (filterKind === 'job' && filterId !== 'all') {
      list = await window.fileshuttleAPI.history.list({ jobId: parseInt(filterId, 10) });
    } else if (filterKind === 'mapping' && filterId !== 'all') {
      list = await window.fileshuttleAPI.history.list({ mappingId: parseInt(filterId, 10) });
    } else {
      list = await window.fileshuttleAPI.history.list();
    }

    const grouped = groupHistory(list).filter((entry) => {
      if (statusFilter !== 'all' && entryStatus(entry) !== statusFilter) return false;
      if (statusFilter !== 'all') return true;
      if (entry.kind === 'standalone' && entry.run.triggerType === 'system') return true;
      if (showEmpty) return true;
      return entry.kind === 'job' ? runMovedFiles(entry.totals) : runMovedFiles(entry.run);
    });
    setEntries(grouped);
    setOpenJobs(new Set(grouped.filter((entry): entry is JobHistoryGroup => entry.kind === 'job').map((entry) => entry.rootId)));
  };

  useEffect(() => {
    void window.fileshuttleAPI.mappings.list().then(setMappings);
    void window.fileshuttleAPI.jobs.list().then(setJobs);
  }, []);

  useEffect(() => {
    void load();
  }, [filterKind, filterId, statusFilter, showEmpty]);

  const mappingFor = (run: RunSummary) =>
    run.mappingId != null ? mappings.find((mapping) => mapping.id === run.mappingId) : undefined;

  const toggleRun = async (run: RunSummary) => {
    const next = new Set(openRuns);
    if (next.has(run.id)) {
      next.delete(run.id);
    } else {
      next.add(run.id);
      if (!expanded[run.id]) {
        const detail = await window.fileshuttleAPI.history.getDetail(run.id);
        setExpanded((current) => ({ ...current, [run.id]: detail }));
      }
    }
    setOpenRuns(next);
  };

  const toggleJob = (rootId: number) => {
    const next = new Set(openJobs);
    if (next.has(rootId)) next.delete(rootId);
    else next.add(rootId);
    setOpenJobs(next);
  };

  const doUndo = async (run: RunSummary) => {
    setConfirmUndo(null);
    const result = await window.fileshuttleAPI.history.undo(run.id);
    setSnackbar(`Undo finished: moved back ${result.filesMoved}, skipped ${result.filesSkipped}, errored ${result.filesErrored}.`);
    await load();
  };

  return (
    <div className="history-page">
      <div className="history-body">
      <h1 className="page-title">History</h1>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <label className="field">
          Filter by
          <select
            value={filterKind}
            onChange={(e) => {
              setFilterKind(e.target.value as 'all' | 'job' | 'mapping');
              setFilterId('all');
            }}
          >
            <option value="all">All runs</option>
            <option value="job">Job</option>
            <option value="mapping">Mapping</option>
          </select>
        </label>
        {filterKind === 'job' && (
          <label className="field">
            Job
            <select value={filterId} onChange={(e) => setFilterId(e.target.value)}>
              <option value="all">All jobs</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>{job.name}</option>
              ))}
            </select>
          </label>
        )}
        {filterKind === 'mapping' && (
          <label className="field">
            Mapping
            <select value={filterId} onChange={(e) => setFilterId(e.target.value)}>
              <option value="all">All mappings</option>
              {mappings.map((mapping) => (
                <option key={mapping.id} value={mapping.id}>{mapping.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | RunStatus)}
          >
            <option value="all">All statuses</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>{runStatusLabel(status)}</option>
            ))}
          </select>
        </label>
        <label className="switch-row">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          Show runs with no files moved
        </label>
      </div>

      {!entries.length ? (
        <div className="empty-state">
          {statusFilter !== 'all'
            ? 'No runs match this status.'
            : showEmpty
              ? 'No runs yet.'
              : 'No runs with moved files yet.'}
        </div>
      ) : (
        entries.map((entry) => {
          if (entry.kind === 'standalone') {
            const run = entry.run;
            return (
              <div key={run.id} className="card">
                <MappingRunRow
                  run={run}
                  mapping={mappingFor(run)}
                  isOpen={openRuns.has(run.id)}
                  expanded={expanded[run.id]}
                  onToggle={() => void toggleRun(run)}
                  onUndo={() => setConfirmUndo(run)}
                />
              </div>
            );
          }

          const jobOpen = openJobs.has(entry.rootId);
          return (
            <div key={`job-${entry.rootId}`} className="card">
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <button className="text" onClick={() => toggleJob(entry.rootId)} style={{ padding: 0 }}>
                  {jobOpen ? '▲' : '▼'}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <StatusBadge counts={entry.totals} />
                    <strong>{entry.jobName}</strong>
                    <span className="muted">{entry.steps.length} mapping{entry.steps.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="muted">
                    ({entry.triggerType}, job) · {entry.startedAt} → {entry.finishedAt} · {totalsSummary(entry.totals)}
                  </div>
                  {jobOpen && (
                    <div className="history-steps">
                      {entry.steps.map((run) => (
                        <div key={run.id} className="history-step">
                          <MappingRunRow
                            run={run}
                            mapping={mappingFor(run)}
                            isOpen={openRuns.has(run.id)}
                            expanded={expanded[run.id]}
                            onToggle={() => void toggleRun(run)}
                            onUndo={() => setConfirmUndo(run)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}
      </div>

      <footer className="status-legend">
        {RUN_STATUSES.map((status) => (
          <span key={status} className="status-legend-item">
            <span className={`badge ${runStatusClass(status)}`}>{runStatusLabel(status)}</span>
            <span className="muted">{runStatusMeaning(status)}</span>
          </span>
        ))}
      </footer>

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
