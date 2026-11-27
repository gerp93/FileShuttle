import { useEffect, useState } from 'react';
import { DEFAULT_REMOTE_PORT, MIN_REMOTE_PASSWORD_LENGTH, RemoteState } from '../../shared/types';
import { errorMessage } from '../utils/errors';

/** Settings > Remote access (desktop only): lets FileShuttle be opened from a phone over Tailscale. */
export default function RemoteAccessSection() {
  const [state, setState] = useState<RemoteState | null>(null);
  const [port, setPort] = useState(String(DEFAULT_REMOTE_PORT));
  const [logins, setLogins] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');

  const adopt = (next: RemoteState) => {
    setState(next);
    setPort(String(next.settings.port));
    setLogins(next.settings.allowedLogins.join('\n'));
  };

  useEffect(() => {
    void window.fileshuttleAPI.remote.getSettings().then(adopt, (err) => setProblem(errorMessage(err)));
  }, []);

  const run = async (action: () => Promise<RemoteState>, done: string) => {
    setProblem('');
    setMessage('');
    try {
      adopt(await action());
      setMessage(done);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  if (!state) {
    return (
      <>
        <h2 style={{ fontSize: 16 }}>Remote access</h2>
        {problem ? <p className="error-text">{problem}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }

  const { settings, status } = state;
  const api = window.fileshuttleAPI.remote;

  return (
    <>
      <h2 style={{ fontSize: 16 }}>Remote access</h2>
      <p className="muted">
        Open FileShuttle from your phone&apos;s browser over your private Tailscale network. Off by default.
        FileShuttle only listens on this PC (127.0.0.1); publish it with{' '}
        <code>tailscale serve --bg {settings.port}</code> and never with Tailscale Funnel.
      </p>

      <div className="switch-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          id="remote-enabled"
          checked={settings.enabled}
          disabled={!settings.hasPassword && !settings.enabled}
          onChange={(e) => void run(() => api.setSettings({ enabled: e.target.checked }), e.target.checked ? 'Remote access is on.' : 'Remote access is off.')}
        />
        <label htmlFor="remote-enabled">Allow access from my phone</label>
      </div>
      {!settings.hasPassword && <p className="muted">Set a password below before turning this on.</p>}
      {status.listening && status.address && (
        <p className="muted">Listening on {status.address} (this PC only).</p>
      )}
      {status.error && <p className="error-text">{status.error}</p>}

      <div className="remote-form">
        <label className="field">
          Port
          <input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <button className="outline" onClick={() => void run(() => api.setSettings({ port: Number(port) }), 'Port saved.')}>
          Save Port
        </button>
      </div>

      <div className="remote-form">
        <label className="field">
          {settings.hasPassword ? 'New password' : 'Password'} (at least {MIN_REMOTE_PASSWORD_LENGTH} characters)
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          className="outline"
          disabled={!password}
          onClick={() =>
            void run(async () => {
              const next = await api.setPassword(password);
              setPassword('');
              return next;
            }, settings.hasPassword ? 'Password changed. Everyone was signed out.' : 'Password saved.')
          }
        >
          {settings.hasPassword ? 'Change Password' : 'Set Password'}
        </button>
      </div>

      <label className="field" style={{ marginBottom: 8, maxWidth: 480 }}>
        Allowed Tailscale logins (optional; one per line or comma-separated, e.g. someone@gmail.com)
        <textarea
          rows={3}
          value={logins}
          spellCheck={false}
          onChange={(e) => setLogins(e.target.value)}
          style={{ font: 'inherit' }}
        />
      </label>
      <p className="muted">
        When this list is not empty, only those Tailscale users get in (checked before the password). It relies on the
        Tailscale-User-Login header that <code>tailscale serve</code> adds, which can be trusted because FileShuttle
        only accepts connections from this PC.
      </p>
      <button
        className="outline"
        onClick={() =>
          void run(
            () => api.setSettings({ allowedLogins: logins.split(/[,\n]+/).map((l) => l.trim()).filter(Boolean) }),
            'Allowed logins saved.'
          )
        }
      >
        Save Allowed Logins
      </button>

      {message && <p className="muted">{message}</p>}
      {problem && <p className="error-text">{problem}</p>}
    </>
  );
}
