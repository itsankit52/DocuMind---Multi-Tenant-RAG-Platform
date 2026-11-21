import { useRef, useState } from 'react';
import { canWrite, useAuth } from '../context/AuthContext';
import { downloadDocument, useDocuments } from '../hooks/useDocuments';
import { Alert, EmptyState, Spinner, StatusBadge } from '../components/Feedback';
import {
  ACCEPTED_UPLOAD_EXTENSIONS, checkUploadFile, fileTypeLabel, formatBytes, formatDateTime, isDocumentPending,
} from '../utils/format';

export function DocumentsPage() {
  const { activeOrganization, role } = useAuth();
  const docs = useDocuments(activeOrganization?.organization_id);
  const writable = canWrite(role);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);

  const pendingCount = docs.documents.filter(d => isDocumentPending(d.status)).length;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Documents</h1>
          <p className="muted">
            {docs.totalCount} document{docs.totalCount === 1 ? '' : 's'}
            {pendingCount > 0 && ` · ${pendingCount} processing (updates automatically)`}
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => docs.reload()} disabled={docs.loading}>
          Refresh
        </button>
      </header>

      {writable
        ? <UploadPanel onUpload={docs.upload} onUploaded={(d) => setNotice(`Uploaded ${d?.original_name || 'document'}. Processing has started.`)} />
        : <Alert tone="info" message="You have read-only access in this organization." />}

      {notice && <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {actionError && <Alert error={actionError} onDismiss={() => setActionError(null)} />}
      {docs.error && <Alert error={docs.error} onRetry={() => docs.reload()} />}

      {docs.loading && docs.documents.length === 0 ? <Spinner label="Loading documents…" /> : (
        docs.documents.length === 0 && !docs.error ? (
          <EmptyState title="No documents yet">Upload a PDF or DOCX file to start asking questions about it.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Documents</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Size</th>
                  <th scope="col">Status</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Updated</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {docs.documents.map(doc => (
                  <DocumentRow key={doc.id} doc={doc} writable={writable} docs={docs} onError={setActionError} />
                ))}
              </tbody>
            </table>
            {docs.hasMore && (
              <div className="load-more">
                <button type="button" className="btn btn-secondary" onClick={() => docs.loadMore()}
                  disabled={docs.loadingMore || docs.loading}>
                  {docs.loadingMore ? 'Loading…' : `Load more (${docs.documents.length} of ${docs.totalCount} shown)`}
                </button>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

function UploadPanel({ onUpload, onUploaded }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const uploading = progress !== null;

  const onChoose = (e) => {
    const f = e.target.files?.[0] || null;
    setFile(f);
    const problem = f ? checkUploadFile(f) : null;
    setError(problem ? { message: problem } : null);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (uploading) return;
    const problem = checkUploadFile(file);
    if (problem) return setError({ message: problem });
    setError(null);
    setProgress(0);
    try {
      const doc = await onUpload(file, setProgress);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onUploaded(doc);
    } catch (err) {
      setError(err);
    } finally {
      setProgress(null);
    }
  };

  return (
    <form className="card upload-panel" onSubmit={onSubmit} aria-label="Upload document">
      <label className="field-label" htmlFor="upload-input">Upload a document (PDF or DOCX)</label>
      <div className="upload-row">
        <input ref={inputRef} id="upload-input" type="file" accept={ACCEPTED_UPLOAD_EXTENSIONS}
          onChange={onChoose} disabled={uploading} className="input" />
        <button type="submit" className="btn btn-primary" disabled={!file || uploading || !!checkUploadFile(file)}>
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {uploading && (
        <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
      )}
      <Alert error={error} />
    </form>
  );
}

function DocumentRow({ doc, writable, docs, onError }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(doc.filename || '');
  const [busy, setBusy] = useState(null);

  const run = async (label, fn) => {
    setBusy(label);
    onError(null);
    try { await fn(); } catch (err) { onError(err); } finally { setBusy(null); }
  };

  const onRename = (e) => {
    e.preventDefault();
    const next = name.trim();
    if (!next || next === doc.filename) return setEditing(false);
    run('rename', async () => { await docs.rename(doc.id, next); setEditing(false); });
  };

  const onDelete = () => {
    if (!window.confirm(`Delete "${doc.original_name || doc.filename}"? This cannot be undone.`)) return;
    run('delete', () => docs.remove(doc.id));
  };

  const displayName = doc.filename || doc.original_name;

  return (
    <tr>
      <td className="cell-name">
        {editing ? (
          <form onSubmit={onRename} className="inline-form">
            <label className="visually-hidden" htmlFor={`rename-${doc.id}`}>New name</label>
            <input id={`rename-${doc.id}`} className="input input-sm" value={name} autoFocus
              onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Escape' && setEditing(false)} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'rename'}>Save</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : <span className="truncate" title={displayName}>{displayName}</span>}
      </td>
      <td>{fileTypeLabel(doc.mime_type)}</td>
      <td>{formatBytes(doc.file_size)}</td>
      <td><StatusBadge status={doc.status} /></td>
      <td>{formatDateTime(doc.created_at)}</td>
      <td>{formatDateTime(doc.updated_at)}</td>
      <td className="cell-actions">
        <button type="button" className="btn btn-link btn-sm" disabled={!!busy}
          onClick={() => run('download', () => downloadDocument(doc))}
          aria-label={`Download ${displayName}`}>
          {busy === 'download' ? 'Downloading…' : 'Download'}
        </button>
        {writable && !editing && (
          <button type="button" className="btn btn-link btn-sm" disabled={!!busy}
            onClick={() => { setName(doc.filename || ''); setEditing(true); }} aria-label={`Rename ${displayName}`}>
            Rename
          </button>
        )}
        {writable && doc.status === 'failed' && (
          <button type="button" className="btn btn-link btn-sm" disabled={!!busy}
            onClick={() => run('reprocess', () => docs.reprocess(doc.id))} aria-label={`Retry processing ${displayName}`}>
            Retry
          </button>
        )}
        {writable && (
          <button type="button" className="btn btn-link btn-sm btn-danger-text" disabled={!!busy}
            onClick={onDelete} aria-label={`Delete ${displayName}`}>
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        )}
      </td>
    </tr>
  );
}
