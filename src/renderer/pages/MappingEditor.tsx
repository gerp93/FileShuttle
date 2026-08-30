import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CreateMappingInput, FilterRule } from '../../shared/types';
import FilterRow from '../components/FilterRow';

const ACTION_TYPES = [
  ['move', 'Move to destination folder'],
  ['copy', 'Copy to destination folder'],
  ['delete', 'Delete (move to Recycle Bin)'],
] as const;

const CONFLICT_POLICIES = [
  ['skip', 'Skip existing files'],
  ['overwrite', 'Overwrite existing files'],
  ['auto_rename', 'Auto-rename (keep both)'],
] as const;

export default function MappingEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;
  const mappingId = id ? parseInt(id, 10) : null;

  const [name, setName] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [destPath, setDestPath] = useState('');
  const [actionType, setActionType] = useState<'move' | 'copy' | 'delete'>('move');
  const [recursive, setRecursive] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [conflictPolicy, setConflictPolicy] = useState<'skip' | 'overwrite' | 'auto_rename'>('skip');
  const [filterMatchMode, setFilterMatchMode] = useState<'all' | 'any'>('all');
  const [filters, setFilters] = useState<FilterRule[]>([]);
  const [keepNewestEnabled, setKeepNewestEnabled] = useState(false);
  const [keepNewestCount, setKeepNewestCount] = useState('3');
  const [error, setError] = useState('');

  useEffect(() => {
    if (mappingId) {
      void window.fileshuttleAPI.mappings.get(mappingId).then((record) => {
        if (!record) return;
        setName(record.name);
        setSourcePath(record.sourcePath);
        setDestPath(record.destPath);
        setActionType(record.actionType);
        setRecursive(record.recursive);
        setEnabled(record.enabled);
        setConflictPolicy(record.conflictPolicy);
        setFilterMatchMode(record.filterMatchMode);
        setFilters(record.filters);
        setKeepNewestEnabled(record.keepNewest != null);
        setKeepNewestCount(String(record.keepNewest ?? 3));
      });
    }
  }, [mappingId]);

  const buildInput = (): CreateMappingInput | null => {
    const trimmedName = name.trim();
    const trimmedSource = sourcePath.trim();
    const trimmedDest = actionType === 'delete' ? '' : destPath.trim();

    if (!trimmedName || !trimmedSource || (actionType !== 'delete' && !trimmedDest)) {
      setError(
        actionType !== 'delete'
          ? 'Name, source folder, and destination folder are all required.'
          : 'Name and source folder are required.'
      );
      return null;
    }

    let keepNewest: number | null = null;
    if (actionType !== 'copy' && keepNewestEnabled) {
      if (!/^\d+$/.test(keepNewestCount.trim()) || parseInt(keepNewestCount.trim(), 10) < 1) {
        setError('Keep newest must be a whole number of at least 1.');
        return null;
      }
      keepNewest = parseInt(keepNewestCount.trim(), 10);
    }

    setError('');
    return {
      name: trimmedName,
      sourcePath: trimmedSource,
      destPath: trimmedDest,
      recursive,
      conflictPolicy,
      enabled,
      scheduleType: 'manual',
      scheduleIntervalMinutes: null,
      scheduleDailyTime: null,
      filters,
      filterMatchMode,
      nextMappingId: null,
      actionType,
      keepNewest,
    };
  };

  const save = async () => {
    const input = buildInput();
    if (!input) return;
    if (isNew) {
      await window.fileshuttleAPI.mappings.create(input);
    } else {
      await window.fileshuttleAPI.mappings.update(mappingId!, input);
    }
    navigate('/mappings');
  };

  const browseSource = async () => {
    const path = await window.fileshuttleAPI.dialogs.pickFolder('Choose source folder');
    if (path) setSourcePath(path);
  };

  const browseDest = async () => {
    const path = await window.fileshuttleAPI.dialogs.pickFolder('Choose destination folder');
    if (path) setDestPath(path);
  };

  return (
    <div>
      <h1 className="page-title">{isNew ? 'New Mapping' : 'Edit Mapping'}</h1>

      <label className="field" style={{ marginBottom: 12 }}>
        Mapping name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="field-row" style={{ marginBottom: 12 }}>
        <label className="field grow">
          Source folder
          <input type="text" value={sourcePath} readOnly />
        </label>
        <button className="outline" onClick={() => void browseSource()}>Browse</button>
      </div>

      <label className="field" style={{ marginBottom: 12 }}>
        Action
        <select value={actionType} onChange={(e) => setActionType(e.target.value as typeof actionType)}>
          {ACTION_TYPES.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>

      {actionType === 'delete' && (
        <p className="error-text">
          Matching files are moved to the Recycle Bin — not to a destination folder.
          This cannot be undone from within FileShuttle.
        </p>
      )}

      {actionType !== 'delete' && (
        <div className="field-row" style={{ marginBottom: 12 }}>
          <label className="field grow">
            Destination folder
            <input type="text" value={destPath} readOnly />
          </label>
          <button className="outline" onClick={() => void browseDest()}>Browse</button>
        </div>
      )}

      <div className="switch-row" style={{ marginBottom: 8 }}>
        <input type="checkbox" id="recursive" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
        <label htmlFor="recursive">Include subfolders (recursive)</label>
      </div>

      {actionType !== 'delete' && (
        <label className="field" style={{ marginBottom: 12 }}>
          If a file already exists at the destination
          <select value={conflictPolicy} onChange={(e) => setConflictPolicy(e.target.value as typeof conflictPolicy)}>
            {CONFLICT_POLICIES.map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
      )}

      <div className="switch-row" style={{ marginBottom: 12 }}>
        <input type="checkbox" id="enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <label htmlFor="enabled">Enabled</label>
      </div>

      <hr className="divider" />

      <div className="page-header">
        <span>Filters (leave empty to move every file)</span>
        <select value={filterMatchMode} onChange={(e) => setFilterMatchMode(e.target.value as 'all' | 'any')}>
          <option value="all">Match ALL filters (AND)</option>
          <option value="any">Match ANY filter (OR)</option>
        </select>
        <button className="text" onClick={() => setFilters([...filters, { field: 'extension', operator: 'equals', value: '' }])}>
          Add Filter
        </button>
      </div>

      {filters.map((rule, i) => (
        <FilterRow
          key={i}
          rule={rule}
          onChange={(updated) => {
            const next = [...filters];
            next[i] = updated;
            setFilters(next);
          }}
          onRemove={() => setFilters(filters.filter((_, j) => j !== i))}
        />
      ))}

      {actionType !== 'copy' && (
        <div style={{ marginTop: 8, marginBottom: 12 }}>
          <div className="switch-row" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              id="keep-newest"
              checked={keepNewestEnabled}
              onChange={(e) => setKeepNewestEnabled(e.target.checked)}
            />
            <label htmlFor="keep-newest">Keep the newest matching files in this folder</label>
          </div>
          {keepNewestEnabled && (
            <label className="field" style={{ maxWidth: 220 }}>
              How many to keep
              <input
                type="number"
                min={1}
                value={keepNewestCount}
                onChange={(e) => setKeepNewestCount(e.target.value)}
              />
            </label>
          )}
          <p className="muted" style={{ margin: '8px 0 0' }}>
            After filters match, files are ranked by last modified time. The newest N stay;
            the rest are {actionType === 'delete' ? 'deleted' : 'moved'}. Pair this with a copy/move
            mapping in the same job to prune a backup folder.
          </p>
        </div>
      )}

      <hr className="divider" />

      {error && <p className="error-text">{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" onClick={() => void save()}>Save</button>
        <button className="outline" onClick={() => navigate('/mappings')}>Cancel</button>
      </div>
    </div>
  );
}
