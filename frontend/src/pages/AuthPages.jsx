import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Alert } from '../components/Feedback';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AuthCard({ title, children }) {
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
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.status === 401 || err.status === 400
        ? { message: 'Invalid email or password.' }
        : err);
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Sign in">
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
      <p className="auth-switch">No account? <Link to="/register">Create one</Link></p>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
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
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  return (
    <AuthCard title="Create your account">
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
      <p className="auth-switch">Already registered? <Link to="/login">Sign in</Link></p>
    </AuthCard>
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
      <p className="auth-switch">
        {organizations.length
          ? <Link to="/">Back to DocuMind</Link>
          : <button type="button" className="btn btn-link" onClick={() => logout().then(() => navigate('/login'))}>Sign out</button>}
      </p>
    </AuthCard>
  );
}
