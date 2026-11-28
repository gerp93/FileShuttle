import { NavLink, Outlet } from 'react-router-dom';
import logo from '../assets/logo.png';
import { isWebMode } from '../utils/platform';
import { UNAUTHORIZED_EVENT, webLogout } from '../webApi';

export default function Layout({ children }: { children?: React.ReactNode }) {
  const web = isWebMode();

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
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
