/**
 * /auth/google/complete — where the backend's Google callback returns the browser.
 *
 * The URL carries only ?status=<code> or ?error=<code> (no token, code or email). It is read
 * once and immediately removed from the address bar/history. On success the backend has
 * already set the normal HttpOnly session cookies, so the session is loaded with /auth/me
 * (refreshUser) exactly like after a password login; routing then follows the usual rules
 * (no organization → onboarding). Invitations are never joined automatically.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Alert, FullPageLoader } from '../components/Feedback';
import { AuthCard } from './AuthPages';
import { googleErrorMessage } from '../components/GoogleSignIn';

const SIGNED_IN = new Set(['signed_in', 'signed_up']);

export function GoogleCompletePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refreshUser, isAuthenticated } = useAuth();
  // Read once: the query is stripped from the URL right after.
  const [result] = useState(() => {
    const params = new URLSearchParams(location.search);
    return { status: params.get('status'), error: params.get('error') };
  });
  const [failure, setFailure] = useState(result.error || (result.status ? null : 'missing'));
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (location.search) navigate(location.pathname, { replace: true }); // drop ?status/?error from history
    if (result.error || !result.status) return;

    (async () => {
      const me = await refreshUser().catch(() => null);
      if (!me?.user) return setFailure('session_missing');
      if (result.status === 'linked') {
        navigate('/settings/account', { replace: true, state: { notice: 'Your Google account is now linked.' } });
      } else if (SIGNED_IN.has(result.status)) {
        navigate('/', { replace: true }); // ProtectedRoute: no organization → onboarding
      } else {
        setFailure('unknown');
      }
    })();
  }, [location.pathname, location.search, navigate, refreshUser, result]);

  if (!failure) return <FullPageLoader label="Completing Google sign-in…" />;

  return (
    <AuthCard title="Couldn’t continue with Google">
      <Alert message={googleErrorMessage(failure)} />
      {isAuthenticated
        ? <p className="auth-switch"><Link to="/settings/account">Back to account settings</Link></p>
        : <p className="auth-switch"><Link to="/login">Back to sign in</Link></p>}
    </AuthCard>
  );
}
