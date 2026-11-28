import { useEffect, useState } from 'react';
import { errorMessage } from '../utils/errors';

/**
 * Settings > Use a remote hub (desktop only). Turns this computer into a worker for a hub running
 * somewhere else (for example the always-on server): the hub's web page replaces this window's
 * interface, and this computer's own scheduler stops. The way back is the same page, reached from
 * the View menu while the hub's page is showing.
 */
export default function RemoteHubSection() {
  const [hubUrl, setHubUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const api = window.fileshuttleAPI.remoteHub;

  useEffect(() => {
    api.getState().then(
      (state) => {
        setHubUrl(state.hubUrl);
        setName(state.name);
        setFolders(state.allowedFolders);
      },
      (err) => setProblem(errorMessage(err))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFolder = async () => {
    const folder = await api.pickFolder();
    if (folder && !folders.includes(folder)) setFolders([...folders, folder]);
  };

  const turnOn = async () => {
    setProblem('');
    setBusy(true);
    try {
      // On success the window is replaced by the hub's page, so there is nothing to update here.
      await api.enable({ hubUrl, code, name, allowedFolders: folders });
    } catch (err) {
      setProblem(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Use a remote hub</h2>
      <p className="muted">
        Let a hub on another machine (for example the always-on server) run this computer&apos;s folders. This computer
        then stops scheduling jobs from its own database, stops phone access and Claude access, and this window shows the
        hub&apos;s web page. Your jobs and mappings here are kept as a backup and come back if you turn this off.
      </p>
      <label className="field">
        <span>Hub address (https, or http for this computer only)</span>
        <input type="text" value={hubUrl} placeholder="https://hub.example.ts.net" onChange={(e) => setHubUrl(e.target.value)} />
      </label>
      <label className="field">
        <span>Pairing code (made on the hub, under Settings &gt; Machines)</span>
        <input type="text" value={code} placeholder="XXXX-XXXX" autoComplete="off" onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="field">
        <span>Machine name (shown on the hub)</span>
        <input type="text" value={name} placeholder="This computer's name" onChange={(e) => setName(e.target.value)} />
      </label>

      <p style={{ marginBottom: 4 }}>Folders this computer lets the hub use</p>
      {folders.length === 0 ? (
        <p className="error-text">
          No folders are allowed, so this computer will refuse every folder the hub asks about. Add at least one.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
          {folders.map((folder) => (
            <li key={folder} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }}>
              <span style={{ flex: 1, fontFamily: 'monospace', wordBreak: 'break-all' }}>{folder}</span>
              <button className="outline" onClick={() => setFolders(folders.filter((f) => f !== folder))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <button className="outline" onClick={() => void addFolder()}>Add a folder…</button>

      <div style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || !hubUrl.trim() || !code.trim()} onClick={() => void turnOn()}>
          {busy ? 'Connecting…' : 'Pair and use this hub'}
        </button>
      </div>
      {problem && <p className="error-text">{problem}</p>}
    </>
  );
}
