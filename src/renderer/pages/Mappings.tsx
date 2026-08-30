import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MappingRecord } from '../../shared/types';
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

  const load = async () => {
    setMappings(await window.fileshuttleAPI.mappings.list());
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = mappings.filter((r) => matches(r, search));

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Mappings</h1>
        <Link to="/editor">
          <button className="primary">New Mapping</button>
        </Link>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        Reusable steps. Add them to a job to run them, in order, and to reuse the same mapping in more than one job.
      </p>

      <label className="field" style={{ marginBottom: 12 }}>
        Search mappings
        <input
          type="text"
          placeholder="Filter by name or folder path"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      {!mappings.length ? (
        <div className="empty-state">No mappings yet. Click &quot;New Mapping&quot; to define a copy, move, or delete step.</div>
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
