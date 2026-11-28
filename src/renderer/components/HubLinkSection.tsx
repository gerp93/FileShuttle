import { useCallback, useEffect, useState } from 'react';
import type { HubLinkState } from '../../shared/types';
import { errorMessage } from '../utils/errors';

const REFRESH_MS = 5000;

/** Settings > Connect to a hub (desktop only): make this computer a worker for a hub running somewhere else. */
export default function HubLinkSection() {
  const api = window.fileshuttleAPI.hubLink;
  const [state, setState] = useState<HubLinkState | null>(null);
  const [hubUrl, setHubUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [folders, setFolders] = useState('');
  const [foldersDirty, setFoldersDirty] = useState(false);
  const [switchOff, setSwitchOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const adopt = useCallback((next: HubLinkState, keepFolders = false) => {
    setState(next);
    if (!keepFolders) {
      setFolders(next.allowedFolders.join('\n'));
      setFoldersDirty(false);
    }
  }, []);

  useEffect(() => {
    void api.getState().then((next) => adopt(next), (err) => setProblem(errorMessage(err)));
    const timer = setInterval(() => {
      void api.getState().then((next) => adopt(next, true), () => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [api, adopt]);

  const run = async <T,>(action: () => Promise<T>, done: (result: T) => string): Promise<T | undefined> => {
    setBusy(true);
    setProblem('');
    setMessage('');
    try {
      const result = await action();
      setMessage(done(result));
      return result;
    } catch (err) {
      setProblem(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const folderList = () => folders.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);

  if (!state) {
    return (
      <>
        <h2 style={{ fontSize: 16 }}>Connect to a hub</h2>
        {problem ? <p className="error-text">{problem}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Connect to a hub</h2>
      {!state.paired ? (
        <>
          <p className="muted">
            Let a FileShuttle hub on another computer (for example your house server) manage this computer&apos;s jobs. The hub
            keeps the mappings, jobs, schedules and history; this computer runs them against its own folders, and only the folders
            you allow. While connected, this app&apos;s own jobs are paused (nothing is deleted). On the hub, make a pairing code
            (Settings → Machines → Pair a Machine, or <code>fileshuttle-server pair-code</code>), then enter its https address and
            the code here.
          </p>
          <div className="remote-form">
            <label className="field">
              Hub address (https)
              <input
                value={hubUrl}
                placeholder="https://holocron.example.ts.net"
                spellCheck={false}
                onChange={(e) => setHubUrl(e.target.value)}
              />
            </label>
            <label className="field">
              Pairing code
              <input value={code} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="field">
              Name on the hub (optional)
              <input value={name} placeholder="this computer's name" onChange={(e) => setName(e.target.value)} />
            </label>
            <button
              className="outline"
              disabled={busy || !hubUrl.trim() || !code.trim()}
              onClick={() =>
                void run(
                  () => api.connect({ hubUrl, code, name: name.trim() || undefined }),
                  () => 'Connected. Now allow the folders your jobs use, then send this computer\'s jobs to the hub if you want them there.'
                ).then((next) => {
                  if (next) {
                    adopt(next);
                    setCode('');
                  }
                })
              }
            >
              Connect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Connected to <strong>{state.hubUrl}</strong> as <strong>{state.name}</strong>:{' '}
            {state.online ? 'online' : 'offline (it keeps running its schedule and reports when the hub is back)'}
            {state.queuedReports > 0
              ? `; ${state.queuedReports} finished run report${state.queuedReports === 1 ? '' : 's'} waiting to be delivered`
              : ''}
            . This computer runs the hub&apos;s jobs; the mappings and jobs under Jobs and Mappings in this window are this
            app&apos;s own and are paused.
          </p>
          {state.problem && <p className="error-text">{state.problem}</p>}

          <label className="field" style={{ marginBottom: 8, maxWidth: 560 }}>
            Folders the hub may use on this computer (one per line; each includes everything inside it)
            <textarea
              rows={5}
              value={folders}
              spellCheck={false}
              placeholder="C:\Users\you\Downloads"
              onChange={(e) => {
                setFolders(e.target.value);
                setFoldersDirty(true);
              }}
              style={{ font: 'inherit' }}
            />
          </label>
          <p className="muted">
            The hub cannot change this list. A job that uses any other folder is refused here. An empty list refuses everything.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              className="outline"
              disabled={busy}
              onClick={() =>
                void api.suggestFolders().then(
                  (found) => {
                    setFolders([...new Set([...folderList(), ...found])].join('\n'));
                    setFoldersDirty(true);
                    setMessage(
                      `${found.length} folder${found.length === 1 ? '' : 's'} from this app's own mappings added to the list. Review it, then Save.`
                    );
                  },
                  (err) => setProblem(errorMessage(err))
                )
              }
            >
              Add the Folders My Mappings Use
            </button>
            <button
              className="outline"
              disabled={busy || !foldersDirty}
              onClick={() =>
                void run(() => api.setAllowedFolders(folderList()), () => 'Allowed folders saved.').then(
                  (next) => next && adopt(next)
                )
              }
            >
              Save Allowed Folders
            </button>
          </div>

          <h3 style={{ fontSize: 14 }}>Bring this computer&apos;s jobs to the hub</h3>
          <p className="muted">
            Copies this app&apos;s mappings and jobs to the hub, on this computer&apos;s account there (they never run on the hub
            itself). Nothing here is changed or deleted. The hub refuses it if this computer already has mappings or jobs there.
            Run history stays in this app.
          </p>
          <div className="switch-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" id="hub-switch-off" checked={switchOff} onChange={(e) => setSwitchOff(e.target.checked)} />
            <label htmlFor="hub-switch-off">Leave the jobs switched off on the hub, so I can look them over first</label>
          </div>
          <button
            className="outline"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.sendDefinitions(switchOff),
                (r) =>
                  `Sent ${r.mappings} mapping${r.mappings === 1 ? '' : 's'} and ${r.jobs} job${r.jobs === 1 ? '' : 's'} to the hub.`
              )
            }
          >
            Send My Mappings and Jobs to the Hub
          </button>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            <button className="outline" onClick={() => void api.openHub()}>Open the Hub</button>
            <button className="outline" disabled={busy} onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
          </div>
        </>
      )}

      {message && <p className="muted">{message}</p>}
      {problem && <p className="error-text">{problem}</p>}

      {confirmDisconnect && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Disconnect from the hub?</h3>
            <p>
              This computer stops working for the hub and goes back to running its own jobs in this app. The hub keeps this
              computer&apos;s mappings, jobs and history (remove it there under Machines when you are done with it).
              {state.queuedReports > 0
                ? ` ${state.queuedReports} finished run report${state.queuedReports === 1 ? '' : 's'} that have not reached the hub yet will be lost.`
                : ''}
            </p>
            <p>
              If you sent this computer&apos;s jobs to the hub, they are now in both places: switch off or delete one set.
            </p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmDisconnect(false);
                  void run(() => api.disconnect(), () => 'Disconnected. This app runs its own jobs again.').then(
                    (next) => next && adopt(next)
                  );
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
