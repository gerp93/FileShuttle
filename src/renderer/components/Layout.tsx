import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import type { HubLinkState } from '../../shared/types';
import logo from '../assets/logo.png';
import { isWebMode } from '../utils/platform';
import { UNAUTHORIZED_EVENT, webLogout } from '../webApi';

export default function Layout({ children }: { children?: React.ReactNode }) {
  const web = isWebMode();
  const [link, setLink] = useState<HubLinkState | null>(null);
  // On the PC only: when it works for a hub, say so on every page (the jobs listed here are then paused).
  useEffect(() => {
    if (web) return;
    const load = () => void window.fileshuttleAPI.hubLink.getState().then(setLink, () => undefined);
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [web]);

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
        {web && (
          <button
            type="button"
            className="nav-button nav-signout"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => void webLogout().then(() => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)))}
          >
            🚪
          </button>
        )}
      </nav>
      <main className="content-area">
        {link?.paired && (
          <div
            className="muted"
            role="status"
            style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px', marginBottom: 12, border: '1px solid currentColor', borderRadius: 6 }}
          >
            <span>
              This computer works for the hub at {link.hubUrl} ({link.online ? 'online' : 'offline'}). Its jobs are managed there;
              the mappings and jobs in this window are this app&apos;s own and are paused.
            </span>
            <button className="outline" onClick={() => void window.fileshuttleAPI.hubLink.openHub()}>Open the Hub</button>
          </div>
        )}
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
