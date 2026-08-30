import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MappingRecord, RunAllSummary } from '../../shared/types';
import MappingCard from '../components/MappingCard';

function matches(record: MappingRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    record.name.toLowerCase().includes(q) ||
    record.sourcePath.toLowerCase().includes(q) ||
    record.destPath.toLowerCase().includes(q)
  );
}

export default function Mappings() {
  const [mappings, setMappings] = useState<MappingRecord[]>([]);
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState('');
  const [runningAll, setRunningAll] = useState(false);

  const load = async () => {
    setMappings(await window.fileshuttleAPI.mappings.list());
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = mappings.filter((r) => matches(r, search));

  const runAll = async () => {
    setRunningAll(true);
    try {
      const result: RunAllSummary = await window.fileshuttleAPI.mappings.runAll();
      setSummary(
        `Ran ${result.mappingCount} enabled mapping(s): moved ${result.filesMoved}, skipped ${result.filesSkipped}, errored ${result.filesErrored}`
      );
      await load();
    } finally {
      setRunningAll(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Mappings</h1>
        <button className="primary" onClick={() => void runAll()} disabled={runningAll}>
          Run All Enabled
        </button>
        <Link to="/editor">
          <button className="primary">New Mapping</button>
        </Link>
      </div>

      <label className="field" style={{ marginBottom: 12 }}>
        Search mappings
        <input
          type="text"
          placeholder="Filter by name or folder path"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      {summary && <p className="muted">{summary}</p>}

      {!mappings.length ? (
        <div className="empty-state">No mappings yet. Click &quot;New Mapping&quot; to move your first batch of files.</div>
      ) : !filtered.length ? (
        <div className="empty-state">No mappings match &quot;{search}&quot;.</div>
      ) : (
        filtered.map((record) => (
          <MappingCard key={record.id} record={record} onChanged={load} />
        ))
      )}
    </div>
  );
}
