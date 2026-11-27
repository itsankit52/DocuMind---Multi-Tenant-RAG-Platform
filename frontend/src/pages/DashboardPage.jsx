import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { organizationApi } from '../api/endpoints';
import { canManageMembers, canWrite, ROLE_LABELS, useAuth } from '../context/AuthContext';
import { useDocuments } from '../hooks/useDocuments';
import { useConversations } from '../hooks/useConversations';
import { Alert, EmptyState, PageHeader, SkeletonRows, StatusBadge } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { fileTypeLabel, formatBytes, formatDateTime, isDocumentPending } from '../utils/format';

const STATS_SAMPLE = 100; // largest page the list API returns

/**
 * Organization overview. Every number comes from an existing endpoint (no stats API exists):
 * document/conversation totals from list pagination, members from the admin-only members list,
 * storage and status counts summed over the most recent documents.
 */
export function DashboardPage() {
  const { activeOrganization, user, role } = useAuth();
  const location = useLocation();
  // One-time message from a flow that navigated here (e.g. invitation accepted). Text only.
  const [notice, setNotice] = useState(() => (typeof location.state?.notice === 'string' ? location.state.notice : null));
  const orgId = activeOrganization?.organization_id;
  const docs = useDocuments(orgId, { limit: STATS_SAMPLE });
  const convs = useConversations(orgId);
  const members = useMemberCount(orgId, canManageMembers(role));

  const counts = docs.documents.reduce((acc, d) => {
    if (d.status === 'ready') acc.ready += 1;
    else if (d.status === 'failed') acc.failed += 1;
    else if (isDocumentPending(d.status)) acc.processing += 1;
    acc.bytes += Number(d.file_size) || 0;
    return acc;
  }, { ready: 0, failed: 0, processing: 0, bytes: 0 });
  const partial = docs.totalCount > docs.documents.length;
  const firstName = user?.fullName?.split(' ')[0];
  const dash = (loading, value) => (loading ? '…' : value);

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description={`Welcome back${firstName ? `, ${firstName}` : ''}. Here’s what’s happening in ${activeOrganization?.name || 'your organization'}.`}
        actions={(
          <>
            <Link to="/chat" className="btn btn-secondary"><Icon name="messageSquare" /> Ask a question</Link>
            {canWrite(role) && (
              <Link to="/documents" state={{ openUpload: true }} className="btn btn-primary"><Icon name="upload" /> Upload document</Link>
            )}
          </>
        )}
      />

      {notice && <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {docs.error && <Alert error={docs.error} onRetry={() => docs.reload()} />}

      <section className="stat-grid" aria-label="Organization statistics" aria-busy={docs.loading}>
        <Stat icon="fileText" label="Total documents" value={dash(docs.loading, docs.totalCount)}
          note={docs.loading ? null : statusNote(counts)} />
        <Stat icon="messageSquare" label="Total conversations"
          value={dash(convs.loading, convs.totalCount ?? convs.conversations.length)} />
        {members.visible ? (
          <Stat icon="users" label="Total members" value={members.error ? '—' : dash(members.loading, members.count)}
            note={members.error ? 'Couldn’t load members' : null} />
        ) : (
          <Stat icon="shieldCheck" label="Your role" value={ROLE_LABELS[role] || '—'} />
        )}
        <Stat icon="hardDrive" label="Storage used" value={dash(docs.loading, formatBytes(counts.bytes))}
          note={!docs.loading && partial ? `Across your ${docs.documents.length} most recent documents` : null} />
      </section>

      <div className="two-col">
        <section className="card" aria-labelledby="recent-docs">
          <div className="card-header">
            <h2 id="recent-docs">Recent documents</h2>
            <Link to="/documents">View all</Link>
          </div>
          {docs.loading ? <SkeletonRows label="Loading documents…" /> : docs.documents.length === 0 ? (
            <EmptyState icon="fileText" title="No documents yet">
              {canWrite(role)
                ? <Link to="/documents" state={{ openUpload: true }}>Upload your first document</Link>
                : 'Documents uploaded by your team will appear here.'}
            </EmptyState>
          ) : (
            <ul className="simple-list">
              {docs.documents.slice(0, 5).map(d => (
                <li key={d.id}>
                  <Link to={`/documents/${d.id}`} className="list-icon">
                    <Icon name="fileText" />
                    <span className="truncate">{d.filename || d.original_name}</span>
                  </Link>
                  <span className="inline-flex shrink-0 items-center gap-3">
                    <span className="muted small hide-sm">{fileTypeLabel(d.mime_type)}</span>
                    <StatusBadge status={d.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="recent-convs">
          <div className="card-header">
            <h2 id="recent-convs">Recent conversations</h2>
            <Link to="/chat">Open chat</Link>
          </div>
          {convs.error && <Alert error={convs.error} onRetry={() => convs.reload()} />}
          {convs.loading ? <SkeletonRows label="Loading conversations…" /> : convs.conversations.length === 0 ? (
            <EmptyState icon="messageSquare" title="No conversations yet">
              <Link to="/chat">Ask your documents a question</Link>
            </EmptyState>
          ) : (
            <ul className="simple-list">
              {convs.conversations.slice(0, 5).map(c => (
                <li key={c.id}>
                  <Link to={`/chat/${c.id}`} className="list-icon">
                    <Icon name="messageSquare" />
                    <span className="truncate">{c.title || 'Untitled conversation'}</span>
                  </Link>
                  <span className="muted small shrink-0">{formatDateTime(c.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function statusNote({ ready, processing, failed }) {
  const parts = [`${ready} ready`];
  if (processing) parts.push(`${processing} processing`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/** Active member count — admins only (the members endpoint is admin-only on the backend). */
function useMemberCount(orgId, visible) {
  const [state, setState] = useState({ loading: true, count: null, error: null });
  useEffect(() => {
    if (!visible || !orgId) return undefined;
    let alive = true;
    setState({ loading: true, count: null, error: null });
    Promise.resolve().then(() => organizationApi.listMembers(orgId))
      .then(r => alive && setState({ loading: false, count: r?.members?.length ?? 0, error: null }))
      .catch(err => alive && setState({ loading: false, count: null, error: err }));
    return () => { alive = false; };
  }, [orgId, visible]);
  return { ...state, visible };
}

function Stat({ icon, label, value, note }) {
  return (
    <div className="stat">
      <span className="stat-label"><Icon name={icon} size={14} /> {label}</span>
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}
