import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDocuments } from '../hooks/useDocuments';
import { useConversations } from '../hooks/useConversations';
import { Alert, EmptyState, Spinner, StatusBadge } from '../components/Feedback';
import { formatDateTime, isDocumentPending } from '../utils/format';

const STATS_SAMPLE = 100; // largest page the list API returns

export function DashboardPage() {
  const { activeOrganization, user } = useAuth();
  const location = useLocation();
  // One-time message from a flow that navigated here (e.g. invitation accepted). Text only.
  const [notice, setNotice] = useState(() => (typeof location.state?.notice === 'string' ? location.state.notice : null));
  const orgId = activeOrganization?.organization_id;
  const docs = useDocuments(orgId, { limit: STATS_SAMPLE });
  const convs = useConversations(orgId);

  // Derived from the existing list endpoint (no stats API exists)
  const counts = docs.documents.reduce((acc, d) => {
    if (d.status === 'ready') acc.ready += 1;
    else if (d.status === 'failed') acc.failed += 1;
    else if (isDocumentPending(d.status)) acc.processing += 1;
    return acc;
  }, { ready: 0, failed: 0, processing: 0 });
  const partial = docs.totalCount > docs.documents.length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Welcome{user?.fullName ? `, ${user.fullName}` : ''} · {activeOrganization?.name}</p>
        </div>
      </header>

      {notice && <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {docs.error && <Alert error={docs.error} onRetry={() => docs.reload()} />}
      <section className="stat-grid" aria-label="Document statistics" aria-busy={docs.loading}>
        <Stat label="Total documents" value={docs.loading ? '…' : docs.totalCount} />
        <Stat label="Processing" value={docs.loading ? '…' : counts.processing} />
        <Stat label="Ready" value={docs.loading ? '…' : counts.ready} />
        <Stat label="Failed" value={docs.loading ? '…' : counts.failed} />
      </section>
      {partial && <p className="muted small">Status counts cover your {docs.documents.length} most recent documents.</p>}

      <div className="two-col">
        <section className="card">
          <div className="card-header">
            <h2>Recent documents</h2>
            <Link to="/documents" className="small">View all</Link>
          </div>
          {docs.loading ? <Spinner /> : docs.documents.length === 0 ? (
            <EmptyState title="No documents yet"><Link to="/documents">Upload your first document</Link></EmptyState>
          ) : (
            <ul className="simple-list">
              {docs.documents.slice(0, 5).map(d => (
                <li key={d.id}>
                  <span className="truncate">{d.original_name || d.filename}</span>
                  <StatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h2>Recent conversations</h2>
            <Link to="/chat" className="small">Open chat</Link>
          </div>
          {convs.error && <Alert error={convs.error} onRetry={() => convs.reload()} />}
          {convs.loading ? <Spinner /> : convs.conversations.length === 0 ? (
            <EmptyState title="No conversations yet"><Link to="/chat">Ask your documents a question</Link></EmptyState>
          ) : (
            <ul className="simple-list">
              {convs.conversations.slice(0, 5).map(c => (
                <li key={c.id}>
                  <Link to={`/chat/${c.id}`} className="truncate">{c.title || 'Untitled conversation'}</Link>
                  <span className="muted small">{formatDateTime(c.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
