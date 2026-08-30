import { NavLink, Outlet } from 'react-router-dom';
import logo from '../assets/logo.png';

export default function Layout({ children }: { children?: React.ReactNode }) {
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
      </nav>
      <main className="content-area">{children ?? <Outlet />}</main>
    </div>
  );
}
