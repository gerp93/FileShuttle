import { FormEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import logo from '../assets/logo.png';
import { errorMessage } from '../utils/errors';
import { isWebMode } from '../utils/platform';
import { applyThemeFromFletId, DEFAULT_THEME_ID } from '../utils/themes';
import { SIGN_IN_REQUIRED, UNAUTHORIZED_EVENT, webLogin } from '../webApi';

type GateState = 'checking' | 'login' | 'ok' | 'unreachable';

/**
 * In the desktop window this renders its children untouched. In the phone's browser it first asks
 * the PC whether the session is signed in, and shows the sign-in form when it is not.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const web = isWebMode();
  const [state, setState] = useState<GateState>(web ? 'checking' : 'ok');
  const [session, setSession] = useState(0);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState('');

  const check = useCallback(async () => {
    setState('checking');
    try {
      await window.fileshuttleAPI.app.getVersion();
      setState('ok');
    } catch (err) {
      const message = errorMessage(err);
      if (message === SIGN_IN_REQUIRED) setState('login');
      else {
        setDetail(message);
        setState('unreachable');
      }
    }
  }, []);

  useEffect(() => {
    if (!web) return;
    void check();
    const onUnauthorized = () => {
      setPassword('');
      setState('login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [web, check]);

  useEffect(() => {
    // The theme is a setting that can't be read before signing in, so the sign-in page uses the default.
    if (state === 'login' || state === 'unreachable' || state === 'checking') applyThemeFromFletId(DEFAULT_THEME_ID);
  }, [state]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    const problem = await webLogin(password);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    setPassword('');
    setSession((n) => n + 1); // remount the app so every page loads fresh
    setState('ok');
  };

  if (state === 'ok') return <div key={session} className="auth-ok">{children}</div>;

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <img src={logo} alt="FileShuttle" width={56} height={56} />
        <h1 className="page-title" style={{ marginTop: 12 }}>FileShuttle</h1>
        {state === 'checking' && <p className="muted">Connecting to your PC…</p>}
        {state === 'unreachable' && (
          <>
            <p className="error-text">{detail}</p>
            <button className="outline" onClick={() => void check()}>Try again</button>
          </>
        )}
        {state === 'login' && (
          <form onSubmit={(e) => void submit(e)}>
            <label className="field">
              Password
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p className="error-text">{error}</p>}
            <button className="primary" type="submit" disabled={busy || !password} style={{ marginTop: 12 }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
