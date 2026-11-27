import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Alert } from '../components/Feedback';
import { setPendingInvitationFromLink } from '../invitations/invitationToken';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Path to return to after sign-in/registration: an in-app path only (never a full URL or token). */
function returnPath(location) {
  const from = location.state?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : null;
}

export function AuthCard({ title, children }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-brand">DocuMind</h1>
        <h2 className="auth-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!EMAIL_RE.test(email) || !password) {
      setError({ message: 'Enter your email address and password.' });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(returnPath(location) || '/', { replace: true });
    } catch (err) {
      setError(err.status === 401 || err.status === 400
        ? { message: 'Invalid email or password.' }
        : err);
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Sign in">
      {returnPath(location) === '/invite' && <Alert tone="info" message="Sign in to continue with your invitation." />}
      {sessionExpired && !error && <Alert tone="info" message="Your session has expired. Please sign in again." />}
      <form onSubmit={onSubmit} noValidate className="form">
        <label className="field-label" htmlFor="login-email">Email</label>
        <input id="login-email" className="input" type="email" autoComplete="email"
          value={email} onChange={e => setEmail(e.target.value)} required />
        <label className="field-label" htmlFor="login-password">Password</label>
        <input id="login-password" className="input" type="password" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} required />
        <Alert error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="auth-switch">No account? <Link to="/register" state={location.state}>Create one</Link></p>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    // UX checks mirroring the backend schema; the backend remains authoritative
    if (!EMAIL_RE.test(form.email)) return setError({ message: 'Enter a valid email address.' });
    if (form.password.length < 8) return setError({ message: 'Password must be at least 8 characters.' });
    if (form.password !== form.confirm) return setError({ message: 'Passwords do not match.' });

    setSubmitting(true);
    setError(null);
    try {
      await register({ email: form.email.trim(), password: form.password, fullName: form.fullName.trim() });
      navigate(returnPath(location) || '/', { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Create your account">
      {returnPath(location) === '/invite' && (
        <Alert tone="info" message="Use the email address that received the invitation. You'll return to it after creating your account." />
      )}
      <form onSubmit={onSubmit} noValidate className="form">
        <label className="field-label" htmlFor="reg-name">Full name</label>
        <input id="reg-name" className="input" autoComplete="name" value={form.fullName} onChange={set('fullName')} />
        <label className="field-label" htmlFor="reg-email">Email</label>
        <input id="reg-email" className="input" type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
        <label className="field-label" htmlFor="reg-password">Password</label>
        <input id="reg-password" className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required />
        <label className="field-label" htmlFor="reg-confirm">Confirm password</label>
        <input id="reg-confirm" className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} required />
        <Alert error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="auth-switch">Already registered? <Link to="/login" state={location.state}>Sign in</Link></p>
    </AuthCard>
  );
}

/**
 * Onboarding → "Join an organization". Invitation-only: the only accepted input is an
 * invitation link (or its token). There is no organization search, name or ID field.
 */
function JoinOrganizationOption() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');
  const [error, setError] = useState(null);

  const onSubmit = (e) => {
    e.preventDefault();
    if (!setPendingInvitationFromLink(link)) {
      setError({ message: 'That does not look like a complete invitation link. Copy the full link you received and try again.' });
      return;
    }
    setLink(''); // the token now lives only in memory (see invitationToken.js)
    navigate('/invite');
  };

  return (
    <section className="join-option" aria-labelledby="join-heading">
      <h3 id="join-heading" className="join-title">Join an organization</h3>
      <p className="muted">Join an organization using an invitation link shared by its administrator.</p>
      {!open ? (
        <button type="button" className="btn btn-secondary btn-block" onClick={() => setOpen(true)}>
          I have an invitation link
        </button>
      ) : (
        <form onSubmit={onSubmit} noValidate className="form" aria-label="Open invitation link">
          <label className="field-label" htmlFor="invite-link">Invitation link</label>
          <input id="invite-link" className="input" type="url" autoComplete="off" spellCheck={false}
            placeholder="Paste the link you received" value={link}
            onChange={e => { setLink(e.target.value); setError(null); }} />
          <p className="muted small">You can also simply open the link you received.</p>
          <Alert error={error} />
          <button type="submit" className="btn btn-primary btn-block">Continue</button>
        </form>
      )}
    </section>
  );
}

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export function OnboardingPage() {
  const { createOrganization, organizations, logout } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const onName = (e) => {
    setName(e.target.value);
    if (!slugTouched) setSlug(slugify(e.target.value));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (name.trim().length < 2) return setError({ message: 'Organization name must be at least 2 characters.' });
    if (!/^[a-z0-9-]{2,}$/.test(slug)) return setError({ message: 'Use at least 2 lowercase letters, numbers or hyphens for the URL name.' });
    setSubmitting(true);
    setError(null);
    try {
      await createOrganization({ name: name.trim(), slug });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title={organizations.length ? 'Create another organization' : 'Create your organization'}>
      <p className="muted">Documents and conversations are private to each organization.</p>
      <form onSubmit={onSubmit} noValidate className="form">
        <label className="field-label" htmlFor="org-name">Organization name</label>
        <input id="org-name" className="input" value={name} onChange={onName} required />
        <label className="field-label" htmlFor="org-slug">URL name</label>
        <input id="org-slug" className="input" value={slug}
          onChange={e => { setSlugTouched(true); setSlug(e.target.value); }} required />
        <Alert error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create organization'}
        </button>
      </form>
      <JoinOrganizationOption />
      <p className="auth-switch">
        {organizations.length
          ? <Link to="/">Back to DocuMind</Link>
          : <button type="button" className="btn btn-link" onClick={() => logout().then(() => navigate('/login'))}>Sign out</button>}
      </p>
    </AuthCard>
  );
}
