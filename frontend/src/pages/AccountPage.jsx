/**
 * /settings/account — sign-in methods for the signed-in user, and explicit Google linking.
 *
 * Linking never happens because emails match: the user is already signed in AND re-enters
 * their password here; the backend then starts Google's consent flow for this account only and
 * links the identity if its verified email equals the account email.
 */

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { authApi } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { Alert } from '../components/Feedback';
import { GoogleLogo } from '../components/GoogleSignIn';
import { AuthCard } from './AuthPages';

export function AccountPage() {
  const { user, organizations, googleSignInEnabled } = useAuth();
  const location = useLocation();
  const methods = user?.authMethods || { password: false, google: false };
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(location.state?.notice || null);

  const onLink = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!password) return setError({ message: 'Enter your current password.' });
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await authApi.linkGoogle(password);
      setPassword('');
      window.location.assign(result.url); // Google's consent page; the callback returns to /auth/google/complete
    } catch (err) {
      setError(err.status === 401 ? { message: 'Incorrect password.' } : err);
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Account">
      <p className="muted">Signed in as <strong>{user?.email}</strong></p>
      <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />
      <h3 className="join-title">Sign-in methods</h3>
      <ul className="simple-list" aria-label="Sign-in methods">
        <li><span>Email and password</span><span className="badge badge-neutral">{methods.password ? 'Enabled' : 'Not set'}</span></li>
        <li>
          <span className="inline-flex items-center gap-2"><GoogleLogo /> Google</span>
          <span className={`badge ${methods.google ? 'badge-success' : 'badge-neutral'}`}>{methods.google ? 'Linked' : 'Not linked'}</span>
        </li>
      </ul>

      {!methods.google && methods.password && googleSignInEnabled && (
        <form className="form join-option" onSubmit={onLink} noValidate aria-label="Link Google account">
          <p className="join-title">Link your Google account</p>
          <p className="muted small">Confirm your password. Then choose the Google account that uses {user?.email}.</p>
          <label className="field-label" htmlFor="link-password">Current password</label>
          <input id="link-password" className="input" type="password" autoComplete="current-password"
            value={password} onChange={e => setPassword(e.target.value)} />
          <Alert error={error} />
          <button type="submit" className="btn btn-google btn-block" disabled={submitting}>
            <GoogleLogo /><span>{submitting ? 'Redirecting to Google…' : 'Link Google account'}</span>
          </button>
        </form>
      )}
      {!methods.google && !googleSignInEnabled && (
        <p className="muted small join-option">Google sign-in isn’t set up on this server.</p>
      )}

      <p className="auth-switch"><Link to={organizations.length ? '/' : '/onboarding'}>Back to DocuMind</Link></p>
    </AuthCard>
  );
}
