import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { canManageMembers, ROLE_LABELS, useAuth } from '../context/AuthContext';
import { Alert } from './Feedback';
import { Icon, LogoMark } from './Icon';

// Navigation hints only — the backend authorizes every request (members/invitations are admin-only)
const NAV = [
  { section: 'Workspace', items: [
    { to: '/', label: 'Dashboard', icon: 'layoutDashboard', end: true },
    { to: '/documents', label: 'Documents', icon: 'fileText' },
    { to: '/chat', label: 'Chat', icon: 'messageSquare' },
  ] },
  { section: 'Organization', items: [
    { to: '/settings/members', label: 'Members', icon: 'users', visible: canManageMembers },
    { to: '/settings/invitations', label: 'Invitations', icon: 'mail', visible: canManageMembers },
    { to: '/settings', label: 'Settings', icon: 'settings', end: true },
  ] },
];

const TITLES = [
  [/^\/$/, ['Dashboard']],
  [/^\/documents\/[^/]+$/, ['Documents', 'Details']],
  [/^\/documents/, ['Documents']],
  [/^\/chat/, ['Chat']],
  [/^\/settings\/members/, ['Members']],
  [/^\/settings\/invitations/, ['Invitations']],
  [/^\/settings/, ['Settings']],
];

function RoleBadge({ role }) {
  if (!role) return null;
  return <span className={`badge badge-role badge-role-${role}`} data-testid="role-badge">{ROLE_LABELS[role] || role}</span>;
}

export function initials(nameOrEmail = '') {
  const parts = nameOrEmail.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function Breadcrumbs({ orgName, pathname }) {
  const trail = (TITLES.find(([re]) => re.test(pathname)) || [null, ['DocuMind']])[1];
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="crumbs">
        {orgName && <li className="hide-sm"><span className="truncate">{orgName}</span><Icon name="chevronRight" size={14} /></li>}
        {trail.map((t, i) => (
          <li key={t}>
            {i === trail.length - 1
              ? <span aria-current="page">{t}</span>
              : <><Link to="/documents" className="text-muted no-underline hover:text-ink">{t}</Link><Icon name="chevronRight" size={14} /></>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Layout() {
  const { user, organizations, activeOrganization, role, selectOrganization, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchError, setSwitchError] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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

  const displayName = user?.fullName || user?.email || '';

  return (
    <div className={`app-shell ${menuOpen ? 'menu-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <aside id="sidebar" className="sidebar">
        <Link to="/" className="brand brand-sidebar"><LogoMark size={26} /> DocuMind</Link>

        <div className="org-switcher">
          <label className="field-label" htmlFor="org-switcher">Organization</label>
          <select id="org-switcher" className="input" value={activeOrganization?.organization_id || ''} onChange={onSwitch}>
            {organizations.map(o => (
              <option key={o.organization_id} value={o.organization_id}>{o.name}</option>
            ))}
          </select>
          <NavLink to="/onboarding" className="org-new"><Icon name="plus" size={13} /> New organization</NavLink>
          {switchError && <Alert error={switchError} onDismiss={() => setSwitchError(null)} />}
        </div>

        <nav aria-label="Main">
          {NAV.map(group => {
            const items = group.items.filter(item => !item.visible || item.visible(role));
            if (items.length === 0) return null;
            return (
              <div key={group.section}>
                <p className="nav-section" aria-hidden="true">{group.section}</p>
                <ul className="nav-list">
                  {items.map(item => (
                    <li key={item.to}>
                      <NavLink to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <Icon name={item.icon} size={16} /> {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="user-box">
            <span className="avatar" aria-hidden="true">{initials(displayName)}</span>
            <span className="user-meta">
              <Link className="user-name" to="/settings/account" title="Account settings">{displayName}</Link>
              {user?.fullName && <span className="user-email">{user.email}</span>}
            </span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm justify-start" onClick={onLogout} disabled={loggingOut}>
            <Icon name="logOut" size={15} /> {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>
      {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <div className="app-main">
        <header className="app-header">
          <button
            type="button"
            className="btn btn-icon menu-toggle"
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={menuOpen}
            aria-controls="sidebar"
            onClick={() => setMenuOpen(o => !o)}
          >
            <Icon name={menuOpen ? 'x' : 'menu'} size={18} />
          </button>
          <Breadcrumbs orgName={activeOrganization?.name} pathname={location.pathname} />
          <RoleBadge role={role} />
        </header>
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
