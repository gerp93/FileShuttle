import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { JobRecord, RunAllSummary } from '../../shared/types';
import JobCard from '../components/JobCard';

function matches(record: JobRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    record.name.toLowerCase().includes(q) ||
    record.steps.some(
      (step) =>
        step.name.toLowerCase().includes(q) ||
        step.sourcePath.toLowerCase().includes(q) ||
        step.destPath.toLowerCase().includes(q)
    )
  );
}

export default function Jobs() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState('');
  const [runningAll, setRunningAll] = useState(false);

  const load = async () => {
    setJobs(await window.fileshuttleAPI.jobs.list());
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = jobs.filter((r) => matches(r, search));

  const runAll = async () => {
    setRunningAll(true);
    try {
      const result: RunAllSummary = await window.fileshuttleAPI.jobs.runAll();
      setSummary(
        `Ran ${result.jobCount} enabled job(s): moved ${result.filesMoved}, skipped ${result.filesSkipped}, errored ${result.filesErrored}`
      );
      await load();
    } finally {
      setRunningAll(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Jobs</h1>
        <button className="primary" onClick={() => void runAll()} disabled={runningAll}>
          Run All Enabled
        </button>
        <Link to="/jobs/new">
          <button className="primary">New Job</button>
        </Link>
      </div>

      <label className="field" style={{ marginBottom: 12 }}>
        Search jobs
        <input
          type="text"
          placeholder="Filter by job or mapping name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      {summary && <p className="muted">{summary}</p>}

      {!jobs.length ? (
        <div className="empty-state">
          No jobs yet. Create mappings first, then a job to run them in order.
        </div>
      ) : !filtered.length ? (
        <div className="empty-state">No jobs match &quot;{search}&quot;.</div>
      ) : (
        filtered.map((record) => <JobCard key={record.id} record={record} onChanged={load} />)
      )}
    </div>
  );
}
