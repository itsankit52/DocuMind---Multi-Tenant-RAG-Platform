import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { canManageMembers, ROLE_LABELS, useAuth } from '../context/AuthContext';
import { Alert } from './Feedback';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/documents', label: 'Documents' },
  { to: '/chat', label: 'Conversations' },
  // Navigation hint only — the backend rejects member APIs for non-admins
  { to: '/settings/members', label: 'Members', visible: canManageMembers },
];

function RoleBadge({ role }) {
  if (!role) return null;
  return <span className={`badge badge-role badge-role-${role}`} data-testid="role-badge">{ROLE_LABELS[role] || role}</span>;
}

export function Layout() {
  const { user, organizations, activeOrganization, role, selectOrganization, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchError, setSwitchError] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  const onSwitch = async (e) => {
    const id = e.target.value;
    setSwitchError(null);
    try {
      await selectOrganization(id);
      navigate('/');
    } catch (err) {
      setSwitchError(err);
    }
  };

  const onLogout = async () => {
    setLoggingOut(true);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className={`app-shell ${menuOpen ? 'menu-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="topbar">
        <button
          type="button"
          className="btn btn-icon menu-toggle"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuOpen(o => !o)}
        >
          ☰
        </button>
        <span className="brand">DocuMind</span>
        <RoleBadge role={role} />
      </header>

      <aside id="sidebar" className="sidebar">
        <div className="brand brand-sidebar">DocuMind</div>
        <nav aria-label="Main">
          <ul className="nav-list">
            {NAV.filter(item => !item.visible || item.visible(role)).map(item => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-footer">
          <label className="field-label" htmlFor="org-switcher">Organization</label>
          <select
            id="org-switcher"
            className="input"
            value={activeOrganization?.organization_id || ''}
            onChange={onSwitch}
          >
            {organizations.map(o => (
              <option key={o.organization_id} value={o.organization_id}>{o.name}</option>
            ))}
          </select>
          <p className="muted small role-line">Your role: <RoleBadge role={role} /></p>
          <NavLink to="/onboarding" className="small">+ New organization</NavLink>
          {switchError && <Alert error={switchError} onDismiss={() => setSwitchError(null)} />}
          <div className="user-box">
            <span className="user-name" title={user?.email}>{user?.fullName || user?.email}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onLogout} disabled={loggingOut}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
