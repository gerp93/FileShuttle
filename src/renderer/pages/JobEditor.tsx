import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MAX_DAILY_TIMES, validateJobInput } from '../../shared/schedule';
import { CreateJobInput, MappingRecord } from '../../shared/types';
import { errorMessage } from '../utils/errors';

const SCHEDULE_TYPES = [
  ['manual', 'Manual only'],
  ['interval', 'Every N minutes'],
  ['daily_at', 'Daily at a specific time'],
  ['watch', 'Watch folder for new files'],
] as const;

export default function JobEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;
  const jobId = id ? parseInt(id, 10) : null;

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [catchUp, setCatchUp] = useState(false);
  const [scheduleType, setScheduleType] = useState<'manual' | 'interval' | 'daily_at' | 'watch'>('manual');
  const [intervalMinutes, setIntervalMinutes] = useState('30');
  const [dailyTimes, setDailyTimes] = useState<string[]>(['09:00']);
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
        setCatchUp(record.catchUp);
        setScheduleType(record.scheduleType);
        setIntervalMinutes(String(record.scheduleIntervalMinutes ?? 30));
        setDailyTimes(record.scheduleDailyTimes.length ? record.scheduleDailyTimes : ['09:00']);
        setMappingIds(record.steps.map((s) => s.id));
      });
    }
  }, [jobId]);

  const byId = (mappingId: number) => allMappings.find((m) => m.id === mappingId);

  const buildInput = (): CreateJobInput | null => {
    const intervalText = intervalMinutes.trim();
    const input: CreateJobInput = {
      name: name.trim(),
      enabled,
      catchUp: scheduleType !== 'manual' && catchUp,
      scheduleType,
      // Text that isn't a whole number becomes NaN, which validation reports.
      scheduleIntervalMinutes:
        scheduleType === 'interval' ? (/^\d+$/.test(intervalText) ? parseInt(intervalText, 10) : NaN) : null,
      scheduleDailyTimes: scheduleType === 'daily_at' ? dailyTimes.map((t) => t.trim()) : [],
      mappingIds,
    };

    const problem = validateJobInput(input);
    if (problem) {
      setError(problem);
      return null;
    }
    setError('');
    return input;
  };

  const save = async () => {
    const input = buildInput();
    if (!input) return;
    try {
      if (isNew) {
        await window.fileshuttleAPI.jobs.create(input);
      } else {
        await window.fileshuttleAPI.jobs.update(jobId!, input);
      }
    } catch (err) {
      setError(errorMessage(err));
      return;
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
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ marginBottom: 4 }}>Times (HH:MM, 24-hour)</div>
          {dailyTimes.map((time, i) => (
            <div key={i} className="filter-row" style={{ alignItems: 'center' }}>
              <input
                type="text"
                aria-label={`Run time ${i + 1}`}
                value={time}
                onChange={(e) => setDailyTimes(dailyTimes.map((t, j) => (j === i ? e.target.value : t)))}
              />
              <button
                className="text danger"
                title="Remove this time"
                disabled={dailyTimes.length === 1}
                onClick={() => setDailyTimes(dailyTimes.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="text"
            disabled={dailyTimes.length >= MAX_DAILY_TIMES}
            onClick={() => setDailyTimes([...dailyTimes, ''])}
          >
            Add time
          </button>
        </div>
      )}

      {scheduleType === 'watch' && (
        <p className="muted" style={{ marginBottom: 12 }}>
          Runs the whole job (every mapping, in order) a moment after a new file or folder
          shows up in the source folder of any mapping below. It does not process only the new
          file. The OS notifies FileShuttle directly — there is no polling, so this has
          effectively no ongoing performance cost. Folders the job itself writes into are not
          watched, so its own output can&apos;t trigger it again.
        </p>
      )}

      {scheduleType !== 'manual' && (
        <div style={{ marginBottom: 12 }}>
          <div className="switch-row">
            <input type="checkbox" id="job-catchup" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
            <label htmlFor="job-catchup">Catch up if FileShuttle wasn&apos;t running</label>
          </div>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {scheduleType === 'watch'
              ? 'When FileShuttle starts or the PC wakes, run once to pick up files that arrived in the meantime.'
              : 'If the app was closed or the PC was asleep when this was due, run once as soon as FileShuttle starts or the PC wakes.'}{' '}
            Schedules only fire while FileShuttle is running.
          </p>
        </div>
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
