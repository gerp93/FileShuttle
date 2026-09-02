import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CreateJobInput, MappingRecord } from '../../shared/types';

const SCHEDULE_TYPES = [
  ['manual', 'Manual only'],
  ['interval', 'Every N minutes'],
  ['daily_at', 'Daily at a specific time'],
  ['watch', 'Watch folder for new files'],
] as const;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export default function JobEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;
  const jobId = id ? parseInt(id, 10) : null;

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [scheduleType, setScheduleType] = useState<'manual' | 'interval' | 'daily_at' | 'watch'>('manual');
  const [intervalMinutes, setIntervalMinutes] = useState('30');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [mappingIds, setMappingIds] = useState<number[]>([]);
  const [allMappings, setAllMappings] = useState<MappingRecord[]>([]);
  const [addId, setAddId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void window.fileshuttleAPI.mappings.list().then(setAllMappings);
    if (jobId) {
      void window.fileshuttleAPI.jobs.get(jobId).then((record) => {
        if (!record) return;
        setName(record.name);
        setEnabled(record.enabled);
        setScheduleType(record.scheduleType);
        setIntervalMinutes(String(record.scheduleIntervalMinutes ?? 30));
        setDailyTime(record.scheduleDailyTime ?? '09:00');
        setMappingIds(record.steps.map((s) => s.id));
      });
    }
  }, [jobId]);

  const byId = (mappingId: number) => allMappings.find((m) => m.id === mappingId);

  const buildInput = (): CreateJobInput | null => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Job name is required.');
      return null;
    }
    if (!mappingIds.length) {
      setError('Add at least one mapping. Jobs run mappings in order.');
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
      enabled,
      scheduleType,
      scheduleIntervalMinutes,
      scheduleDailyTime,
      mappingIds,
    };
  };

  const save = async () => {
    const input = buildInput();
    if (!input) return;
    if (isNew) {
      await window.fileshuttleAPI.jobs.create(input);
    } else {
      await window.fileshuttleAPI.jobs.update(jobId!, input);
    }
    navigate('/');
  };

  const addMapping = () => {
    const idToAdd = parseInt(addId, 10);
    if (!idToAdd || mappingIds.includes(idToAdd)) return;
    setMappingIds([...mappingIds, idToAdd]);
    setAddId('');
  };

  const move = (index: number, delta: number) => {
    const next = [...mappingIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setMappingIds(next);
  };

  const available = allMappings.filter((m) => !mappingIds.includes(m.id));

  return (
    <div>
      <h1 className="page-title">{isNew ? 'New Job' : 'Edit Job'}</h1>

      <label className="field" style={{ marginBottom: 12 }}>
        Job name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="switch-row" style={{ marginBottom: 12 }}>
        <input type="checkbox" id="job-enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <label htmlFor="job-enabled">Enabled</label>
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

      {scheduleType === 'watch' && (
        <p className="muted" style={{ marginBottom: 12 }}>
          Runs the moment a new file or folder shows up in the source folder of the first
          mapping below (the OS notifies FileShuttle directly — there is no polling, so this
          has effectively no ongoing performance cost). Only fires while FileShuttle is running.
        </p>
      )}

      <hr className="divider" />

      <div className="page-header">
        <span>Mappings (run in this order)</span>
        <Link to="/editor">
          <button className="text">New Mapping</button>
        </Link>
      </div>

      {!allMappings.length && (
        <p className="muted">No mappings yet. Create a mapping first, then add it here.</p>
      )}

      {mappingIds.map((mappingId, i) => {
        const mapping = byId(mappingId);
        return (
          <div key={`${mappingId}-${i}`} className="filter-row" style={{ alignItems: 'center' }}>
            <span className="muted" style={{ width: 24 }}>{i + 1}.</span>
            <span className="grow">{mapping?.name ?? `Mapping #${mappingId} (deleted)`}</span>
            <button className="text" onClick={() => move(i, -1)} disabled={i === 0} title="Move up">↑</button>
            <button className="text" onClick={() => move(i, 1)} disabled={i === mappingIds.length - 1} title="Move down">↓</button>
            <button className="text danger" onClick={() => setMappingIds(mappingIds.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}

      {available.length > 0 && (
        <div className="field-row" style={{ marginTop: 12 }}>
          <label className="field grow">
            Add mapping
            <select value={addId} onChange={(e) => setAddId(e.target.value)}>
              <option value="">Choose a mapping…</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <button className="outline" onClick={addMapping} disabled={!addId}>Add</button>
        </div>
      )}

      <p className="muted" style={{ marginTop: 8 }}>
        The same mapping can be reused in other jobs. Removing it here does not delete the mapping.
      </p>

      <hr className="divider" />

      {error && <p className="error-text">{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" onClick={() => void save()}>Save</button>
        <button className="outline" onClick={() => navigate('/')}>Cancel</button>
      </div>
    </div>
  );
}
