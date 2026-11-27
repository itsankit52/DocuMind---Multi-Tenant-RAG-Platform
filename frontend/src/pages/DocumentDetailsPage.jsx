/**
 * /documents/:documentId — metadata, processing state and actions for one document.
 * Uses GET /documents/:id and GET /documents/:id/processing (polled while processing).
 * There is no preview endpoint, so the file is offered as a download only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { documentApi } from '../api/endpoints';
import { canWrite, useAuth } from '../context/AuthContext';
import { downloadDocument, POLL_INTERVAL_MS } from '../hooks/useDocuments';
import { Alert, EmptyState, PageHeader, SkeletonRows, StatusBadge } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { RenameForm, useUploaderNames } from '../components/DocumentParts';
import { fileTypeLabel, formatBytes, formatDateTime, isDocumentPending } from '../utils/format';

// Worker stages (backend workers/processor.js)
const STAGE_LABELS = { text_extraction: 'Extracting text', chunking: 'Splitting into sections', embedding: 'Creating embeddings', indexing: 'Indexing for search', completed: 'Completed' };

export function DocumentDetailsPage() {
  const { documentId } = useParams();
  const { activeOrganization, role, user } = useAuth();
  const orgId = activeOrganization?.organization_id;
  const writable = canWrite(role);
  const uploaderName = useUploaderNames(orgId, role, user?.id);
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [processing, setProcessing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [d, p] = await Promise.all([
        documentApi.get(documentId),
        documentApi.processing(documentId).catch(() => null), // details still render without it
      ]);
      if (!alive.current) return;
      setDoc(d?.document || null);
      setProcessing(p);
      setLoadError(null);
    } catch (err) {
      if (alive.current && !silent) setLoadError(err);
    } finally {
      if (alive.current && !silent) setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    alive.current = true;
    setDoc(null);
    if (orgId) load();
    return () => { alive.current = false; };
  }, [orgId, load]);

  // Follow processing until the document is ready or failed
  useEffect(() => {
    if (!doc || !isDocumentPending(doc.status)) return undefined;
    const t = setTimeout(() => load({ silent: true }), POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [doc, load]);

  const run = async (label, fn) => {
    setBusy(label);
    setActionError(null);
    try { await fn(); } catch (err) { if (alive.current) setActionError(err); } finally { if (alive.current) setBusy(null); }
  };

  if (loading) return <div className="page"><SkeletonRows rows={6} label="Loading document…" /></div>;
  if (loadError || !doc) {
    return (
      <div className="page">
        <BackLink />
        {loadError?.status === 404 || !loadError ? (
          <EmptyState icon="fileText" title="Document not found">
            It may have been deleted, or it belongs to another organization.
          </EmptyState>
        ) : <Alert error={loadError} onRetry={() => load()} />}
      </div>
    );
  }

  const name = doc.filename || doc.original_name;
  const job = processing?.job;
  const onDelete = () => {
    if (!window.confirm(`Delete "${doc.original_name || doc.filename}"? This cannot be undone.`)) return;
    run('delete', async () => { await documentApi.remove(doc.id); navigate('/documents', { replace: true }); });
  };

  return (
    <div className="page">
      <BackLink />
      {editing ? (
        <div className="mb-6 max-w-xl">
          <RenameForm doc={doc} onError={setActionError} onDone={() => setEditing(false)}
            onRename={async (id, filename) => { const r = await documentApi.rename(id, filename); if (r?.document) setDoc(x => ({ ...x, ...r.document })); }} />
        </div>
      ) : (
        <PageHeader
          title={<span className="wrap-anywhere">{name}</span>}
          description={<span className="inline-flex flex-wrap items-center gap-2">{fileTypeLabel(doc.mime_type)} · {formatBytes(doc.file_size)} <StatusBadge status={doc.status} /></span>}
          actions={(
            <>
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => run('download', () => downloadDocument(doc))}>
                <Icon name="download" /> {busy === 'download' ? 'Downloading…' : 'Download'}
              </button>
              {writable && (
                <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setEditing(true)}>
                  <Icon name="pencil" /> Rename
                </button>
              )}
              {writable && doc.status === 'failed' && (
                <button type="button" className="btn btn-secondary" disabled={!!busy}
                  onClick={() => run('reprocess', async () => { await documentApi.reprocess(doc.id); await load({ silent: true }); })}>
                  <Icon name="refresh" /> Retry processing
                </button>
              )}
              {writable && (
                <button type="button" className="btn btn-secondary btn-danger-text" disabled={!!busy} onClick={onDelete}>
                  <Icon name="trash" /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </>
          )}
        />
      )}

      {actionError && <Alert error={actionError} onDismiss={() => setActionError(null)} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="card" aria-labelledby="doc-meta">
          <h2 id="doc-meta" className="mt-0 mb-4">Details</h2>
          <dl className="meta-grid">
            <Meta label="Document name">{name}</Meta>
            {doc.original_name && doc.original_name !== name && <Meta label="Original file name">{doc.original_name}</Meta>}
            <Meta label="File type">{fileTypeLabel(doc.mime_type)}</Meta>
            <Meta label="Size">{formatBytes(doc.file_size)}</Meta>
            <Meta label="Uploaded by">{uploaderName(doc.uploaded_by)}</Meta>
            <Meta label="Upload date">{formatDateTime(doc.created_at)}</Meta>
            <Meta label="Last updated">{formatDateTime(doc.updated_at)}</Meta>
          </dl>
          <p className="muted small mt-6 mb-0 border-t border-line pt-4">
            In-app preview isn’t available for this file type. Download the file to open it.
          </p>
        </section>

        <section className="card" aria-labelledby="doc-processing">
          <h2 id="doc-processing" className="mt-0 mb-4">Processing</h2>
          <dl className="m-0 grid gap-4">
            <Meta label="Status"><StatusBadge status={doc.status} /></Meta>
            {job?.stage && isDocumentPending(doc.status) && <Meta label="Current step">{STAGE_LABELS[job.stage] || job.stage}</Meta>}
            {typeof processing?.chunkCount === 'number' && <Meta label="Indexed sections">{processing.chunkCount}</Meta>}
            {job && <Meta label="Attempts">{job.attempts}{job.maxAttempts ? ` of ${job.maxAttempts}` : ''}</Meta>}
            {job?.finishedAt && <Meta label="Finished">{formatDateTime(job.finishedAt)}</Meta>}
          </dl>
          {doc.status === 'failed' && (
            <p className="muted small mb-0">Processing didn’t complete. {writable ? 'Retry to process it again.' : 'Ask a member or admin to retry.'}</p>
          )}
          {doc.status === 'ready' && (
            <Link to="/chat" className="btn btn-secondary btn-sm mt-5"><Icon name="messageSquare" /> Ask about your documents</Link>
          )}
        </section>
      </div>
    </div>
  );
}

function BackLink() {
  return <Link to="/documents" className="back-link"><Icon name="arrowLeft" size={14} /> All documents</Link>;
}

function Meta({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="mx-0 mt-1 mb-0 text-[14px] wrap-anywhere">{children}</dd>
    </div>
  );
}
