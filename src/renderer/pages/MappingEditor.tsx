import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CreateMappingInput, FilterRule, MappingRecord } from '../../shared/types';
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

const SCHEDULE_TYPES = [
  ['manual', 'Manual only'],
  ['interval', 'Every N minutes'],
  ['daily_at', 'Daily at a specific time'],
] as const;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
  const [scheduleType, setScheduleType] = useState<'manual' | 'interval' | 'daily_at'>('manual');
  const [intervalMinutes, setIntervalMinutes] = useState('30');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [filterMatchMode, setFilterMatchMode] = useState<'all' | 'any'>('all');
  const [filters, setFilters] = useState<FilterRule[]>([]);
  const [nextMappingId, setNextMappingId] = useState<number | null>(null);
  const [otherMappings, setOtherMappings] = useState<MappingRecord[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.fileshuttleAPI.mappings.list().then((all) => {
      setOtherMappings(all.filter((m) => m.id !== mappingId));
    });
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
        setScheduleType(record.scheduleType);
        setIntervalMinutes(String(record.scheduleIntervalMinutes ?? 30));
        setDailyTime(record.scheduleDailyTime ?? '09:00');
        setFilterMatchMode(record.filterMatchMode);
        setFilters(record.filters);
        setNextMappingId(record.nextMappingId);
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

    let scheduleIntervalMinutes: number | null = null;
    let scheduleDailyTime: string | null = null;

    if (scheduleType === 'interval') {
      if (!/^\d+$/.test(intervalMinutes.trim())) {
        setError('Interval must be a whole number of minutes.');
        return null;
      }
      scheduleIntervalMinutes = parseInt(intervalMinutes.trim(), 10);
    } else if (scheduleType === 'daily_at') {
      if (!TIME_RE.test(dailyTime.trim())) {
        setError('Time must be in HH:MM 24-hour format, e.g. 09:00.');
        return null;
      }
      scheduleDailyTime = dailyTime.trim();
    }

    setError('');
    return {
      name: trimmedName,
      sourcePath: trimmedSource,
      destPath: trimmedDest,
      recursive,
      conflictPolicy,
      enabled,
      scheduleType,
      scheduleIntervalMinutes,
      scheduleDailyTime,
      filters,
      filterMatchMode,
      nextMappingId,
      actionType,
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
    navigate('/');
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

      <label className="field" style={{ marginBottom: 12 }}>
        Schedule
        <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value as typeof scheduleType)}>
          {SCHEDULE_TYPES.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>

      {scheduleType === 'interval' && (
        <label className="field" style={{ marginBottom: 12 }}>
          Interval (minutes)
          <input type="number" value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} />
        </label>
      )}

      {scheduleType === 'daily_at' && (
        <label className="field" style={{ marginBottom: 12 }}>
          Time (HH:MM, 24-hour)
          <input type="text" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} />
        </label>
      )}

      <hr className="divider" />

      <label className="field" style={{ marginBottom: 12 }}>
        When this finishes, then run
        <select
          value={nextMappingId ?? ''}
          onChange={(e) => setNextMappingId(e.target.value ? parseInt(e.target.value, 10) : null)}
        >
          <option value="">Nothing — run independently</option>
          {otherMappings.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </label>

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

      <hr className="divider" />

      {error && <p className="error-text">{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" onClick={() => void save()}>Save</button>
        <button className="outline" onClick={() => navigate('/')}>Cancel</button>
      </div>
    </div>
  );
}
