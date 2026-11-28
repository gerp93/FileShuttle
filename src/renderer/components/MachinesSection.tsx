import { useCallback, useEffect, useState } from 'react';
import type { PairCodeInfo, WorkerInfo } from '../../shared/types';
import { errorMessage } from '../utils/errors';
import { isWebMode } from '../utils/platform';

const REFRESH_MS = 10_000;

function lastSeenText(worker: WorkerInfo): string {
  if (worker.kind === 'local') return 'this computer';
  if (worker.online) return 'online';
  if (!worker.lastSeenAt) return 'offline, never connected';
  return `offline, last seen ${new Date(worker.lastSeenAt).toLocaleString()}`;
}

function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  if (left === 0) return 'expired';
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
}

/** Settings > Machines: the computers that run jobs, and a way to pair another one. */
export default function MachinesSection() {
  const web = isWebMode();
  const api = window.fileshuttleAPI.workers;
  const [machines, setMachines] = useState<WorkerInfo[] | null>(null);
  const [pairing, setPairing] = useState<PairCodeInfo | null>(null);
  const [now, setNow] = useState(Date.now());
  const [problem, setProblem] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<WorkerInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(
    () => api.list().then(setMachines, (err) => setProblem(errorMessage(err))),
    [api]
  );
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const makeCode = async () => {
    setProblem('');
    setCopied(false);
    try {
      setPairing(await api.createPairCode());
      setNow(Date.now());
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  const remove = async (worker: WorkerInfo) => {
    setConfirmRemove(null);
    setProblem('');
    try {
      await api.remove(worker.id);
      await reload();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  // The page's own address is the hub's address when it is open in a browser; on the PC it is not known here.
  const hubUrl = web ? window.location.origin : 'https://<hub address>';
  const command = pairing
    ? `fileshuttle-server worker pair --hub ${hubUrl} --code ${pairing.code}`
    : '';
  const expired = pairing ? new Date(pairing.expiresAt).getTime() <= now : false;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setProblem('Could not copy; select the command and copy it by hand.');
    }
  };

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Machines</h2>
      <p className="muted">
        Computers that move files for you. Each one only touches the folders it was set up to allow. Pair another
        computer to run jobs there; this one keeps its own jobs.
      </p>

      {machines?.map((m) => (
        <div key={m.id} className="remote-form">
          <span>
            {m.name}{' '}
            <span className="muted">
              {m.platform ? `${m.platform}, ` : ''}
              {m.appVersion ? `version ${m.appVersion}, ` : ''}
              {lastSeenText(m)}
              {m.queuedRunCount > 0 ? `, ${m.queuedRunCount} run${m.queuedRunCount === 1 ? '' : 's'} waiting` : ''}
            </span>
            {m.versionNotice && <span className="error-text" style={{ display: 'block' }}>{m.versionNotice}</span>}
          </span>
          {m.kind === 'remote' && (
            <button className="outline" onClick={() => setConfirmRemove(m)}>Remove</button>
          )}
        </div>
      ))}

      <button className="outline" onClick={() => void makeCode()}>Pair a Machine</button>

      {pairing && (
        <div className="muted" style={{ marginTop: 8 }}>
          <p>
            Pairing code: <strong style={{ fontSize: 18, letterSpacing: 2 }}>{pairing.code}</strong>{' '}
            ({countdown(pairing.expiresAt, now)}, works once)
          </p>
          <p>On the other computer, run:</p>
          <p>
            <code style={{ wordBreak: 'break-all' }}>{command}</code>
          </p>
          {!web && (
            <p>
              Replace <code>&lt;hub address&gt;</code> with the https address this computer is reachable at.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="outline" disabled={expired} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy Command'}
            </button>
            <button className="outline" onClick={() => void makeCode()}>New Code</button>
          </div>
        </div>
      )}
      {problem && <p className="error-text">{problem}</p>}

      {confirmRemove && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Remove {confirmRemove.name}?</h3>
            <p>
              It stops being able to connect, and its token is deleted. Its run history stays. To use it again, pair it
              again.
            </p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmRemove(null)}>Cancel</button>
              <button className="primary" onClick={() => void remove(confirmRemove)}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
