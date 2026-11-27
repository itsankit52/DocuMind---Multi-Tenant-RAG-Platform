/**
 * Members page → Invitations (admin only in the UI; every call is authorized by the backend).
 *
 *   POST   /organizations/:id/invitations                     create → shareable link (shown once)
 *   GET    /organizations/:id/invitations?page&limit&status   list (effective status)
 *   POST   /organizations/:id/invitations/:invId/resend       new link; the old one stops working
 *   DELETE /organizations/:id/invitations/:invId              revoke
 *
 * No email is sent (no SMTP): the admin copies the link and shares it. The link (it contains
 * the raw token) lives only in the open dialog's state and is dropped when the dialog closes.
 * It is never logged, stored, or put in a URL of this app.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invitationApi } from '../api/endpoints';
import { ROLE_LABELS, ROLES } from '../context/AuthContext';
import { Alert, EmptyState, Spinner } from './Feedback';
import { Modal } from './Modal';
import { formatDateTime } from '../utils/format';
import { resolveInvitationLink } from '../invitations/invitationLink';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INVITATIONS_PAGE_SIZE = 10;
const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'expired', label: 'Expired' },
];
const STATUS_TONES = { pending: 'pending', accepted: 'success', revoked: 'danger', expired: 'neutral' };
const STATUS_LABELS = { pending: 'Pending', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired' };

export function InvitationsPanel({ orgId }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState({ invitations: [], pagination: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [dialog, setDialog] = useState(null); // null | { type: 'create' } | { type: 'share', link, email, role, resent }
  const requestSeq = useRef(0);
  const active = useRef(true);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const result = await invitationApi.list(orgId, { page, limit: INVITATIONS_PAGE_SIZE, status: filter || undefined });
      if (!active.current || seq !== requestSeq.current) return;
      const invitations = result?.invitations || [];
      if (invitations.length === 0 && page > 1) { setPage(p => p - 1); return; } // page emptied (e.g. revoke)
      setList({ invitations, pagination: result?.pagination || null });
      setError(null);
    } catch (err) {
      if (active.current && seq === requestSeq.current) setError(err);
    } finally {
      if (active.current && seq === requestSeq.current) setLoading(false);
    }
  }, [orgId, page, filter]);

  useEffect(() => {
    active.current = true;
    if (orgId) load();
    return () => { active.current = false; };
  }, [orgId, load]);

  const onFilter = (e) => { setFilter(e.target.value); setPage(1); };

  const onCreated = (result) => {
    setDialog({
      type: 'share',
      link: resolveInvitationLink(result || {}),
      email: result?.invitation?.email,
      role: result?.invitation?.role,
      resent: false,
    });
    if (page === 1) load(); else setPage(1);
  };

  const onResend = async (inv) => {
    if (busyId) return;
    setBusyId(inv.id);
    setNotice(null);
    setError(null);
    try {
      const result = await invitationApi.resend(orgId, inv.id);
      if (!active.current) return;
      setDialog({ type: 'share', link: resolveInvitationLink(result || {}), email: inv.email, role: inv.role, resent: true });
      await load();
    } catch (err) {
      if (active.current) { setError(err); await load(); }
    } finally {
      if (active.current) setBusyId(null);
    }
  };

  const onRevoke = async (inv) => {
    if (busyId) return;
    if (!window.confirm(`Revoke the invitation for ${inv.email}? The invitation link will stop working.`)) return;
    setBusyId(inv.id);
    setNotice(null);
    setError(null);
    try {
      await invitationApi.revoke(orgId, inv.id);
      if (!active.current) return;
      setNotice(`The invitation for ${inv.email} was revoked.`);
      await load();
    } catch (err) {
      if (active.current) { setError(err); await load(); } // e.g. 409 already accepted: show the real state
    } finally {
      if (active.current) setBusyId(null);
    }
  };

  const { invitations, pagination } = list;
  const totalPages = Math.max(1, pagination?.totalPages || 1);

  return (
    <section className="card invitations" aria-labelledby="invitations-heading">
      <div className="card-header">
        <div>
          <h2 id="invitations-heading">Invitations</h2>
          <p className="muted small">Invite people by email. You'll get a link to share with them — no email is sent.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ type: 'create' })}>Invite member</button>
      </div>

      <div className="invitations-toolbar">
        <label className="field-label" htmlFor="invitation-status-filter">Status</label>
        <select id="invitation-status-filter" className="input input-sm" value={filter} onChange={onFilter}>
          {STATUS_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      {notice && <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <Alert error={error} onRetry={load} onDismiss={() => setError(null)} />}

      {loading && invitations.length === 0 ? <Spinner label="Loading invitations…" /> : invitations.length === 0 ? (
        <EmptyState title={filter ? `No ${STATUS_LABELS[filter].toLowerCase()} invitations` : 'No invitations yet'} />
      ) : (
        <div className="table-wrap" aria-busy={loading}>
          <table className="table">
            <caption className="visually-hidden">Organization invitations</caption>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Expires</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map(inv => (
                <tr key={inv.id}>
                  <td className="truncate">{inv.email}</td>
                  <td><span className={`badge badge-role badge-role-${inv.role}`}>{ROLE_LABELS[inv.role] || inv.role}</span></td>
                  <td><span className={`badge badge-${STATUS_TONES[inv.status] || 'neutral'}`}>{STATUS_LABELS[inv.status] || inv.status}</span></td>
                  <td>{formatDateTime(inv.created_at)}</td>
                  <td>{formatDateTime(inv.expires_at)}</td>
                  <td className="cell-actions">
                    {inv.status === 'pending' && (
                      <>
                        <button type="button" className="btn btn-link" disabled={busyId !== null}
                          onClick={() => onResend(inv)} aria-label={`Resend invitation to ${inv.email}`}>
                          {busyId === inv.id ? 'Working…' : 'Resend'}
                        </button>
                        <button type="button" className="btn btn-link btn-danger-text" disabled={busyId !== null}
                          onClick={() => onRevoke(inv)} aria-label={`Revoke invitation to ${inv.email}`}>
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalCount > 0 && totalPages > 1 && (
        <nav className="pager" aria-label="Invitation pages">
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span className="muted small">Page {page} of {totalPages}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>Next</button>
        </nav>
      )}

      {dialog?.type === 'create' && (
        <InviteDialog orgId={orgId} onClose={() => setDialog(null)} onCreated={onCreated} />
      )}
      {dialog?.type === 'share' && (
        <ShareLinkDialog {...dialog} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}

function InviteDialog({ orgId, onClose, onCreated }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting.current) return;
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) return setError({ message: 'Enter a valid email address.' });
    if (!ROLES.includes(role)) return setError({ message: 'Choose a role.' });
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await invitationApi.create(orgId, { email: trimmed, role });
      onCreated(result);
    } catch (err) {
      submitting.current = false;
      setError(err);
      setSaving(false);
    }
  };

  return (
    <Modal title="Invite member" onClose={onClose} closeDisabled={saving}>
      <form onSubmit={onSubmit} noValidate className="form" aria-label="Invite member">
        <label className="field-label" htmlFor="invite-email">Email address</label>
        <input id="invite-email" className="input" type="email" autoComplete="off" placeholder="name@company.com"
          value={email} onChange={e => setEmail(e.target.value)} required />
        <label className="field-label" htmlFor="invite-role">Role</label>
        <select id="invite-role" className="input" value={role} onChange={e => setRole(e.target.value)} required>
          {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <Alert error={error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create invitation'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ShareLinkDialog({ link, email, role, resent, onClose }) {
  const [copyState, setCopyState] = useState(null); // null | 'copied' | 'failed'
  const inputRef = useRef(null);

  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
      inputRef.current?.select(); // let the admin copy it manually
    }
  };

  return (
    <Modal title={resent ? 'New invitation link' : 'Invitation created'} onClose={onClose}>
      {link && (
        <p>
          {resent
            ? 'A new link was generated. The previous link no longer works.'
            : 'Invitation created. Copy and share this link with the invited person.'}
        </p>
      )}
      {!link && (
        <Alert message={resent
          ? 'A new invitation link was issued (the previous link no longer works), but a shareable link could not be generated. Contact your application administrator.'
          : 'Invitation created, but a shareable link could not be generated. Contact your application administrator.'} />
      )}
      <p className="muted small">
        For <strong>{email}</strong> as <span className={`badge badge-role badge-role-${role}`}>{ROLE_LABELS[role] || role}</span>.
        {' '}No email was sent{link ? ' — share the link yourself (e.g. chat or email)' : ''}. It expires in 72 hours and works
        only for someone signed in with that email address.
      </p>
      {link ? (
        <>
          <label className="field-label" htmlFor="invite-link-output">Invitation link</label>
          <div className="upload-row">
            <input id="invite-link-output" ref={inputRef} className="input" readOnly value={link}
              onFocus={e => e.target.select()} />
            <button type="button" className="btn btn-primary" onClick={onCopy}>Copy invitation link</button>
          </div>
          {copyState === 'copied' && <Alert tone="success" message="Link copied to the clipboard." />}
          {copyState === 'failed' && <Alert message="Couldn't copy automatically. The link is selected — copy it manually." />}
        </>
      ) : (
        <>
          <p className="muted small">
            The invitation is saved and appears in the invitation list. The application URL needs to be
            configured (the backend&apos;s APP_BASE_URL, or VITE_PUBLIC_APP_URL for the frontend build);
            afterwards, use Resend to get a working link.
          </p>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
