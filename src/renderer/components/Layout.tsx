import { useCallback, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import logo from '../assets/logo.png';
import AssistantPanel, { AssistantStatus } from './AssistantPanel';
import './assistant.css';

const OPEN_KEY = 'fileshuttle-assistant-open';

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

// Pages that only list saved data: they reload when the assistant saves something. The editors are
// left alone so an open form is never thrown away.
const LIST_PAGES = new Set(['/', '/mappings', '/history']);

export default function Layout({ children }: { children?: React.ReactNode }) {
  const agent = window.fileshuttleAPI?.agent;
  const location = useLocation();
  const [open, setOpen] = useState(readOpen);
  const [status, setStatus] = useState<AssistantStatus>({ running: false, needsApproval: false });
  const [dataVersion, setDataVersion] = useState(0);

  const setOpenPersisted = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const onDataChanged = useCallback(() => setDataVersion((v) => v + 1), []);

  const attention = status.needsApproval ? ' assistant-attention' : '';
  const badge = status.needsApproval ? ' · needs your OK' : status.running ? ' · working…' : '';

  return (
    <div className="app-shell">
      <nav className="nav-rail">
        <img src={logo} alt="FileShuttle" />
        <NavLink to="/" className={({ isActive }) => `nav-button${isActive ? ' active' : ''}`} title="Jobs" end>
          📋
        </NavLink>
        <NavLink to="/mappings" className={({ isActive }) => `nav-button${isActive ? ' active' : ''}`} title="Mappings">
          📁
        </NavLink>
        <NavLink to="/history" className={({ isActive }) => `nav-button${isActive ? ' active' : ''}`} title="History">
          📜
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `nav-button${isActive ? ' active' : ''}`} title="Settings">
          ⚙️
        </NavLink>
        {agent && (
          <button
            type="button"
            className={`nav-button nav-assistant${open ? ' active' : ''}${attention}`}
            title={`Assistant${badge}`}
            aria-label={`Assistant${badge}`}
            aria-pressed={open}
            onClick={() => setOpenPersisted(!open)}
          >
            🤖
            {(status.running || status.needsApproval) && <span className="nav-assistant-dot" />}
          </button>
        )}
      </nav>
      <main className="content-area" key={LIST_PAGES.has(location.pathname) ? dataVersion : 0}>
        {children ?? <Outlet />}
      </main>
      {agent && (
        // Stays mounted while closed so the conversation and any pending approval are not lost.
        <aside className={`assistant-dock${open ? '' : ' assistant-dock-closed'}`}>
          <AssistantPanel
            agent={agent}
            onClose={() => setOpenPersisted(false)}
            onStatus={setStatus}
            onDataChanged={onDataChanged}
          />
        </aside>
      )}
    </div>
  );
}
