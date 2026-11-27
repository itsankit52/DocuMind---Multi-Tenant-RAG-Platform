/**
 * /invite — invitation preview and acceptance (public route; works signed in or out).
 *
 * Token handling: see ../invitations/invitationToken.js (fragment → memory, URL cleaned
 * immediately, never persisted or logged). Signing in / registering are client-side
 * navigations back to /invite, so the in-memory token survives them.
 *
 * The backend answers every invalid case (unknown, expired, revoked, used, wrong account)
 * with the same 404, on purpose. This page shows one generic message and never guesses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { invitationApi } from '../api/endpoints';
import { ROLE_LABELS, useAuth } from '../context/AuthContext';
import { Alert, FullPageLoader, Spinner } from '../components/Feedback';
import { AuthCard } from './AuthPages';
import { formatDateTime } from '../utils/format';
import {
  captureInvitationFromUrl, clearPendingInvitationToken, getPendingInvitationToken,
} from '../invitations/invitationToken';

const ALREADY_MEMBER = 'ALREADY_ORGANIZATION_MEMBER';
const RETURN_STATE = { from: '/invite' }; // a path only — never the token

// The backend's 404 is deliberately identical for every invalid case (including a different
// account), so this wording is neutral: it never claims the current account is the cause.
export const UNAVAILABLE_TEXT = 'This invitation is unavailable. It may be invalid, expired, revoked, or no longer active.';
// Invitations open only for the account whose email received them; this wording covers the
// common case of an invitee without an account yet, and still reveals nothing about the token.
export const TRY_ANOTHER_ACCOUNT_TEXT = 'An invitation opens only for the email address it was sent to. Sign out, then sign in, or create an account, with that email address.';

export function InvitePage() {
  const { loading, isAuthenticated, user, organizations, logout, joinOrganization } = useAuth();
  const navigate = useNavigate();
  const [linkState, setLinkState] = useState('checking'); // checking | ready | missing | malformed
  const [token, setToken] = useState(null);
  const [preview, setPreview] = useState({ status: 'idle' }); // idle | loading | ready | unavailable | error
  const [acceptState, setAcceptState] = useState({ status: 'idle' }); // idle | submitting | already-member | unavailable | error | joined
  const accepting = useRef(false);
  const mounted = useRef(true);

  // 1. Capture the token from the fragment (once; StrictMode-safe) and clean the URL.
  useEffect(() => {
    mounted.current = true;
    const result = captureInvitationFromUrl();
    if (result === 'malformed') {
      clearPendingInvitationToken();
      setLinkState('malformed');
    } else {
      const pending = getPendingInvitationToken();
      setToken(pending);
      setLinkState(pending ? 'ready' : 'missing');
    }
    return () => { mounted.current = false; };
  }, []);

  const forgetToken = useCallback(() => {
    clearPendingInvitationToken();
    setToken(null);
  }, []);

  // 2. Preview once signed in (again after switching accounts).
  const loadPreview = useCallback(async () => {
    setPreview({ status: 'loading' });
    try {
      const result = await invitationApi.preview(token);
      if (mounted.current) setPreview({ status: 'ready', invitation: result?.invitation || null });
    } catch (err) {
      if (!mounted.current) return;
      if (err.status === 404) setPreview({ status: 'unavailable' });
      else if (err.status === 401) setPreview({ status: 'idle' }); // session handler signs out → sign-in prompt
      else setPreview({ status: 'error', error: err });
    }
  }, [token]);

  useEffect(() => {
    if (!loading && isAuthenticated && token) loadPreview();
  }, [loading, isAuthenticated, token, user?.id, loadPreview]);

  // 3. Accept: one request at a time, never retried automatically.
  const onAccept = async () => {
    if (accepting.current || !token) return;
    accepting.current = true;
    setAcceptState({ status: 'submitting' });
    let result;
    try {
      result = await invitationApi.accept(token);
    } catch (err) {
      accepting.current = false;
      if (!mounted.current) return;
      if (err.status === 409 && err.code === ALREADY_MEMBER) {
        forgetToken();
        setAcceptState({ status: 'already-member' });
      } else if (err.status === 404) {
        forgetToken();
        setAcceptState({ status: 'unavailable' });
      } else if (err.status === 401) {
        setAcceptState({ status: 'idle' }); // signed out by the session handler; token kept for sign-in
      } else {
        setAcceptState({ status: 'error', error: err }); // 409 busy, 429, 5xx, network: manual retry
      }
      return;
    }

    forgetToken();
    const name = result?.organization?.name || 'the organization';
    try {
      await joinOrganization(result?.organization?.id);
    } catch {
      if (mounted.current) setAcceptState({ status: 'joined', name });
      return;
    }
    navigate('/', { replace: true, state: { notice: `You're now a member of ${name}.` } });
  };

  const onNotNow = () => {
    forgetToken();
    navigate(isAuthenticated && organizations.length ? '/' : '/onboarding', { replace: true });
  };

  // Existing sign-out, then the login flow. Whatever token is STILL in memory is kept for the
  // next account; a token already cleared (e.g. after a 404 on accept) is never restored.
  const onSwitchAccount = async () => {
    await logout();
    navigate('/login', { replace: true, state: RETURN_STATE });
  };

  // ─── Rendering ───────────────────────────────────────────────────────────────
  if (loading || linkState === 'checking') return <FullPageLoader label="Loading invitation…" />;

  if (acceptState.status === 'joined') {
    return (
      <AuthCard title="Invitation accepted">
        <Alert tone="success" message={`You're now a member of ${acceptState.name}.`} />
        <button type="button" className="btn btn-primary btn-block" onClick={() => window.location.assign('/')}>
          Open DocuMind
        </button>
      </AuthCard>
    );
  }

  if (acceptState.status === 'already-member') {
    const orgName = preview.invitation?.organizationName;
    return (
      <AuthCard title="Already a member">
        <p>You already belong to {orgName ? <strong>{orgName}</strong> : 'this organization'}. Your current role was not changed.</p>
        <Link className="btn btn-primary btn-block" to="/" replace>Go to DocuMind</Link>
      </AuthCard>
    );
  }

  if (linkState === 'malformed') {
    return (
      <AuthCard title="Invalid invitation link">
        <p>This invitation link is incomplete or invalid. Copy the full link from the message you received and open it again.</p>
        <BackLink />
      </AuthCard>
    );
  }

  if (!token && acceptState.status !== 'unavailable') {
    return (
      <AuthCard title="Open your invitation link">
        <p>To join an organization, open the invitation link its administrator shared with you.</p>
        <p className="muted small">
          For your security the link is removed from the address bar as soon as it is opened. If you
          refreshed this page, please open the invitation link again.
        </p>
        <BackLink />
      </AuthCard>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthCard title="You've been invited to DocuMind">
        <p>Sign in or create an account with the email address that received the invitation to view it.</p>
        <Link className="btn btn-primary btn-block" to="/login" state={RETURN_STATE}>Sign in</Link>
        <p className="auth-switch">New to DocuMind? <Link to="/register" state={RETURN_STATE}>Create an account</Link></p>
      </AuthCard>
    );
  }

  if (preview.status === 'unavailable' || acceptState.status === 'unavailable') {
    return (
      <AuthCard title="Invitation unavailable">
        <p>{UNAVAILABLE_TEXT}</p>
        <section className="try-account" aria-labelledby="try-account-heading">
          <h3 id="try-account-heading" className="join-title">Try another account</h3>
          <p className="muted">{TRY_ANOTHER_ACCOUNT_TEXT}</p>
          <p className="muted small">Signed in as {user?.email}</p>
          <button type="button" className="btn btn-secondary btn-block" onClick={onSwitchAccount}>
            Try another account
          </button>
        </section>
        <BackLink />
      </AuthCard>
    );
  }

  if (preview.status === 'error') {
    return (
      <AuthCard title="Couldn't load the invitation">
        <Alert error={preview.error} onRetry={loadPreview} />
        <BackLink />
      </AuthCard>
    );
  }

  if (preview.status !== 'ready') {
    return <AuthCard title="Invitation"><Spinner label="Loading invitation…" /></AuthCard>;
  }

  const { invitation } = preview;
  const submitting = acceptState.status === 'submitting';
  return (
    <AuthCard title="You're invited to join">
      <section className="invite-summary" aria-label="Invitation details">
        <p className="invite-org">{invitation?.organizationName}</p>
        {invitation?.inviterName && <p className="muted">Invited by {invitation.inviterName}</p>}
        <dl className="invite-facts">
          <div>
            <dt>Role</dt>
            <dd><span className={`badge badge-role badge-role-${invitation?.role}`}>{ROLE_LABELS[invitation?.role] || invitation?.role}</span></dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{formatDateTime(invitation?.expiresAt)}</dd>
          </div>
        </dl>
      </section>
      {acceptState.status === 'error' && <Alert error={acceptState.error} />}
      <div className="invite-actions">
        <button type="button" className="btn btn-primary" onClick={onAccept} disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Joining…' : acceptState.status === 'error' ? 'Try again' : 'Accept invitation'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onNotNow} disabled={submitting}>Not now</button>
      </div>
      <p className="muted small">Signed in as {user?.email}</p>
    </AuthCard>
  );
}

function BackLink() {
  const { isAuthenticated, organizations } = useAuth();
  if (!isAuthenticated) return <p className="auth-switch"><Link to="/login">Go to sign in</Link></p>;
  return <p className="auth-switch"><Link to={organizations.length ? '/' : '/onboarding'}>Back to DocuMind</Link></p>;
}
