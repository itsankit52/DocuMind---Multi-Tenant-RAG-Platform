import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, EmptyState, Spinner } from './Feedback';
import { formatDateTime } from '../utils/format';
import { Icon } from './Icon';

export function ConversationSidebar({
  conversations, loading, error, activeId, onCreate, onRename, onDelete, onReload, creating,
  hasMore = false, loadingMore = false, onLoadMore,
}) {
  return (
    <aside className="conv-sidebar" aria-label="Conversations">
      <div className="conv-sidebar-header">
        <h2>Conversations</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : <><Icon name="plus" size={14} /> New</>}
        </button>
      </div>
      {error && <Alert error={error} onRetry={onReload} />}
      {loading ? <Spinner label="Loading conversations…" /> : conversations.length === 0 && !error ? (
        <EmptyState icon="messageSquare" title="No conversations yet">Start one to ask questions about your documents.</EmptyState>
      ) : (
        <ul className="conv-list">
          {conversations.map(c => (
            <ConversationItem key={c.id} conversation={c} active={c.id === activeId} onRename={onRename} onDelete={onDelete} />
          ))}
        </ul>
      )}
      {!loading && hasMore && onLoadMore && (
        <div className="load-more">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more conversations'}
          </button>
        </div>
      )}
    </aside>
  );
}

function ConversationItem({ conversation, active, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const label = conversation.title || 'Untitled conversation';

  const save = async (e) => {
    e.preventDefault();
    const next = title.trim();
    if (!next || next === conversation.title) return setEditing(false);
    setBusy(true);
    setError(null);
    try {
      await onRename(conversation.id, next);
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${label}"? Its messages will no longer be available.`)) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(conversation.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <li className={`conv-item ${active ? 'active' : ''}`}>
      {editing ? (
        <form onSubmit={save} className="inline-form">
          <label className="visually-hidden" htmlFor={`conv-title-${conversation.id}`}>Conversation title</label>
          <input id={`conv-title-${conversation.id}`} className="input input-sm" value={title} autoFocus maxLength={255}
            onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Escape' && setEditing(false)} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save</button>
        </form>
      ) : (
        <>
          <Link to={`/chat/${conversation.id}`} className="conv-link" aria-current={active ? 'page' : undefined}>
            <span className="truncate">{label}</span>
            <span className="muted small">{formatDateTime(conversation.updated_at)}</span>
          </Link>
          {(onRename || onDelete) && (
            <span className="conv-actions">
              {onRename && (
                <button type="button" className="btn btn-link btn-sm" disabled={busy}
                  onClick={() => { setTitle(conversation.title || ''); setEditing(true); }} aria-label={`Rename ${label}`}>
                  Rename
                </button>
              )}
              {onDelete && (
                <button type="button" className="btn btn-link btn-sm btn-danger-text" disabled={busy}
                  onClick={remove} aria-label={`Delete ${label}`}>
                  Delete
                </button>
              )}
            </span>
          )}
        </>
      )}
      {error && <Alert error={error} onDismiss={() => setError(null)} />}
    </li>
  );
}
