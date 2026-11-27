import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { FullPageLoader } from './Feedback';

/**
 * Renders children only after the session is resolved.
 * requireOrganization: users without an active membership go to onboarding.
 */
export function ProtectedRoute({ requireOrganization = true }) {
  const { loading, isAuthenticated, activeOrganization } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (requireOrganization && !activeOrganization) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}

/**
 * Hides pages the current role can't use (UX only). If this check were bypassed, the
 * backend would still reject the underlying API calls with 403.
 */
export function RequireRole({ roles }) {
  const { role } = useAuth();
  if (!roles.includes(role)) {
    return (
      <div className="page">
        <h1>Not available</h1>
        <p className="muted">Your role in this organization doesn't include access to this page.</p>
      </div>
    );
  }
  return <Outlet />;
}

/**
 * Login/register pages: signed-in users go straight to the app — or back to the in-app path
 * they came from (e.g. /invite). Only same-app paths are honored.
 */
export function PublicOnlyRoute() {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoader />;
  if (isAuthenticated) {
    const from = location.state?.from;
    const target = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
    return <Navigate to={target} replace />;
  }
  return <Outlet />;
}
