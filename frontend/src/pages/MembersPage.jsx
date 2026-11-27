/**
 * Organization → Members (admin only in the UI; enforced by the backend). Invitations live on
 * their own page (/settings/invitations).
 *
 * Uses the existing endpoints:
 *   GET  /api/organizations/:id/members          list active members
 *   POST /api/organizations/:id/members          add a registered user by email, or change a role
 *   DELETE /api/organizations/:id/members/:userId remove a member
 * The backend refuses to demote or remove the last admin (409); the UI also prevents it up front.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { organizationApi } from '../api/endpoints';
import { ROLE_LABELS, ROLES, useAuth } from '../context/AuthContext';
import { Alert, EmptyState, PageHeader, SkeletonRows } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { initials } from '../components/Layout';
import { Link } from 'react-router-dom';
import { formatDateTime } from '../utils/format';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MembersPage() {
  const { activeOrganization, user, refreshUser } = useAuth();
  const orgId = activeOrganization?.organization_id;
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const active = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await organizationApi.listMembers(orgId);
      if (!active.current) return;
      // Don't clear `error` here: a reload after a rejected change must keep its message
      setMembers(result?.members || []);
    } catch (err) {
      if (active.current) setError(err);
    } finally {
      if (active.current) setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    active.current = true;
    setLoading(true);
    if (orgId) load();
    return () => { active.current = false; };
  }, [orgId, load]);

  const adminCount = members.filter(m => m.role === 'admin').length;

  /** Save a role, then refresh members — and the session if it was our own role. */
  const saveRole = async (member, role) => {
    if (role === member.role) return;
    const isSelf = member.id === user?.id;
    if (isSelf && member.role === 'admin'
      && !window.confirm('You will lose admin access to this organization. Continue?')) return;

    setSavingId(member.id);
    setNotice(null);
    setError(null);
    try {
      await organizationApi.saveMember(orgId, { email: member.email, role });
      if (isSelf) {
        await refreshUser(); // new permissions apply immediately (may leave this page)
        return;
      }
      await load();
      setNotice(`${member.full_name || member.email} is now ${ROLE_LABELS[role]}.`);
    } catch (err) {
      setError(err);
      await load(); // show the authoritative state
    } finally {
      if (active.current) setSavingId(null);
    }
  };

  /** Remove a member after confirmation; removing yourself refreshes the session. */
  const removeMember = async (member) => {
    const isSelf = member.id === user?.id;
    const who = member.full_name || member.email;
    const question = isSelf
      ? 'Remove yourself from this organization? You will lose access immediately.'
      : `Remove ${who} from this organization? They will lose access immediately.`;
    if (!window.confirm(question)) return;

    setSavingId(member.id);
    setNotice(null);
    setError(null);
    try {
      await organizationApi.removeMember(orgId, member.id);
      if (isSelf) {
        await refreshUser();
        return;
      }
      await load();
      setNotice(`${who} was removed from the organization.`);
    } catch (err) {
      setError(err);
      await load();
    } finally {
      if (active.current) setSavingId(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Members"
        description={`${members.length || ''} ${members.length === 1 ? 'person has' : 'people have'} access to ${activeOrganization?.name || 'this organization'}`.trim()}
        actions={(
          <Link to="/settings/invitations" state={{ invite: true }} className="btn btn-primary">
            <Icon name="mail" /> Invite member
          </Link>
        )}
      />
      <AddMemberForm orgId={orgId} onAdded={async (msg) => { await load(); setNotice(msg); }} />

      {notice && <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <Alert error={error} onDismiss={() => setError(null)} />}

      {loading ? <div className="card"><SkeletonRows label="Loading members…" /></div> : members.length === 0 ? (
        <div className="card"><EmptyState icon="users" title="No members found" /></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Organization members</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col" className="hide-sm">Joined</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {members.map(m => {
                const lastAdmin = m.role === 'admin' && adminCount <= 1;
                const isSelf = m.id === user?.id;
                return (
                  <tr key={m.id}>
                    <td>
                      <span className="inline-flex items-center gap-2.5">
                        <span className="avatar" aria-hidden="true">{initials(m.full_name || m.email)}</span>
                        <span className="font-medium">{m.full_name || '—'}{isSelf && <span className="muted small font-normal"> (you)</span>}</span>
                      </span>
                    </td>
                    <td className="muted">{m.email}</td>
                    <td>
                      <label className="visually-hidden" htmlFor={`role-${m.id}`}>Role for {m.email}</label>
                      <select id={`role-${m.id}`} className="input input-sm role-select" value={m.role}
                        disabled={savingId === m.id} onChange={e => saveRole(m, e.target.value)}
                        aria-describedby={lastAdmin ? `last-admin-${m.id}` : undefined}>
                        {ROLES.map(r => (
                          <option key={r} value={r} disabled={lastAdmin && r !== 'admin'}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                      {lastAdmin && <span id={`last-admin-${m.id}`} className="muted small"> Last admin</span>}
                    </td>
                    <td className="hide-sm">{formatDateTime(m.created_at)}</td>
                    <td className="cell-actions">
                      <button type="button" className="btn btn-secondary btn-sm btn-danger-text"
                        disabled={savingId === m.id || lastAdmin}
                        title={lastAdmin ? 'The last admin cannot be removed' : undefined}
                        aria-label={`Remove ${m.email}`} onClick={() => removeMember(m)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="card role-help" aria-label="What each role can do">
        <h2 className="mt-0">Roles</h2>
        <ul>
          <li><strong>Admin</strong> — everything a member can do, plus managing members, roles and invitations.</li>
          <li><strong>Member</strong> — upload, rename and delete documents; ask questions; manage conversations.</li>
          <li><strong>Viewer</strong> — read and download documents and ask questions. No changes.</li>
        </ul>
      </section>
    </div>
  );
}

function AddMemberForm({ orgId, onAdded }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (!EMAIL_RE.test(email.trim())) return setError({ message: 'Enter a valid email address.' });
    setSaving(true);
    setError(null);
    try {
      await organizationApi.saveMember(orgId, { email: email.trim(), role });
      setEmail('');
      await onAdded(`${email.trim()} was added as ${ROLE_LABELS[role]}.`);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card add-member" onSubmit={onSubmit} aria-label="Add member" noValidate>
      <p className="field-label">Add an existing user</p>
      <p className="muted small">Add someone who already has a DocuMind account. To invite someone new, send an invitation.</p>
      <div className="upload-row">
        <label className="visually-hidden" htmlFor="member-email">Email</label>
        <input id="member-email" className="input" type="email" placeholder="name@company.com"
          value={email} onChange={e => setEmail(e.target.value)} />
        <label className="visually-hidden" htmlFor="member-role">Role</label>
        <select id="member-role" className="input role-select" value={role} onChange={e => setRole(e.target.value)}>
          {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add member'}</button>
      </div>
      <Alert error={error} />
    </form>
  );
}
