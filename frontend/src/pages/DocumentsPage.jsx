import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { canWrite, useAuth } from '../context/AuthContext';
import { useDocuments } from '../hooks/useDocuments';
import { Alert, EmptyState, PageHeader, SkeletonRows, StatusBadge } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { DocumentActions, RenameForm, UploadDialog, useUploaderNames } from '../components/DocumentParts';
import { fileTypeLabel, formatBytes, formatDateTime, isDocumentPending } from '../utils/format';

const TYPE_FILTERS = [['', 'All types'], ['PDF', 'PDF'], ['DOCX', 'DOCX']];
const STATUS_FILTERS = [['', 'All statuses'], ['ready', 'Ready'], ['pending', 'Processing'], ['failed', 'Failed']];
const SORTS = {
  newest: ['Newest first', null], // server order (created_at DESC)
  oldest: ['Oldest first', (a, b) => new Date(a.created_at) - new Date(b.created_at)],
  name: ['Name A–Z', (a, b) => (a.filename || '').localeCompare(b.filename || '')],
  size: ['Largest first', (a, b) => (Number(b.file_size) || 0) - (Number(a.file_size) || 0)],
};

export function DocumentsPage() {
  const { activeOrganization, role, user } = useAuth();
  const orgId = activeOrganization?.organization_id;
  const docs = useDocuments(orgId);
  const writable = canWrite(role);
  const uploaderName = useUploaderNames(orgId, role, user?.id);
  const location = useLocation();
  const navigate = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(() => !!location.state?.openUpload && writable);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');

  const pendingCount = docs.documents.filter(d => isDocumentPending(d.status)).length;
  const filtering = !!(query.trim() || type || status);

  // Filters run over the loaded pages (the list API has no search/filter parameters)
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = docs.documents.filter(d => (
      (!q || `${d.filename || ''} ${d.original_name || ''}`.toLowerCase().includes(q))
      && (!type || fileTypeLabel(d.mime_type) === type)
      && (!status || (status === 'pending' ? isDocumentPending(d.status) : d.status === status))
    ));
    const cmp = SORTS[sort][1];
    return cmp ? [...list].sort(cmp) : list;
  }, [docs.documents, query, type, status, sort]);

  const closeUpload = () => {
    setUploadOpen(false);
    if (location.state?.openUpload) navigate(location.pathname, { replace: true, state: null });
  };

  return (
    <div className="page">
      <PageHeader
        title="Documents"
        description={(
          <>
            {docs.totalCount} document{docs.totalCount === 1 ? '' : 's'}
            {pendingCount > 0 && ` · ${pendingCount} processing (updates automatically)`}
          </>
        )}
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => docs.reload()} disabled={docs.loading}>
              <Icon name="refresh" /> Refresh
            </button>
            {writable && (
              <button type="button" className="btn btn-primary" onClick={() => setUploadOpen(true)}>
                <Icon name="upload" /> Upload document
              </button>
            )}
          </>
        )}
      />

      {!writable && <Alert tone="info" message="You have read-only access in this organization." />}
      {notice && <Alert tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {actionError && <Alert error={actionError} onDismiss={() => setActionError(null)} />}
      {docs.error && <Alert error={docs.error} onRetry={() => docs.reload()} />}

      {docs.documents.length > 0 && (
        <div className="toolbar" role="search" aria-label="Filter documents">
          <span className="search-input">
            <Icon name="search" />
            <label className="visually-hidden" htmlFor="doc-search">Search documents</label>
            <input id="doc-search" className="input" type="search" placeholder="Search by name"
              value={query} onChange={e => setQuery(e.target.value)} />
          </span>
          <Select id="doc-type" label="File type" value={type} onChange={setType} options={TYPE_FILTERS} />
          <Select id="doc-status" label="Processing status" value={status} onChange={setStatus} options={STATUS_FILTERS} />
          <Select id="doc-sort" label="Sort" value={sort} onChange={setSort}
            options={Object.entries(SORTS).map(([k, [l]]) => [k, l])} />
          {filtering && (
            <span className="toolbar-note" role="status">
              {visible.length} of {docs.documents.length}{docs.hasMore ? ' loaded' : ''} shown
            </span>
          )}
        </div>
      )}

      {docs.loading && docs.documents.length === 0 ? <div className="card"><SkeletonRows rows={5} label="Loading documents…" /></div> : (
        docs.documents.length === 0 && !docs.error ? (
          <div className="card">
            <EmptyState icon="fileText" title="No documents yet">
              Upload a PDF or DOCX file to start asking questions about it.
              {writable && (
                <div><button type="button" className="btn btn-primary" onClick={() => setUploadOpen(true)}>
                  <Icon name="upload" /> Upload document
                </button></div>
              )}
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Documents</caption>
              <thead>
                <tr>
                  <th scope="col">Document name</th>
                  <th scope="col" className="hide-sm">File type</th>
                  <th scope="col" className="hide-sm">Size</th>
                  <th scope="col" className="hide-md">Uploaded by</th>
                  <th scope="col" className="hide-md">Upload date</th>
                  <th scope="col">Processing status</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(doc => (
                  <DocumentRow key={doc.id} doc={doc} writable={writable} docs={docs}
                    uploader={uploaderName(doc.uploaded_by)} onError={setActionError} />
                ))}
                {visible.length === 0 && (
                  <tr><td colSpan={7}><EmptyState icon="search" title="No matching documents">Try a different search or filter.</EmptyState></td></tr>
                )}
              </tbody>
            </table>
            {docs.hasMore && (
              <div className="load-more">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => docs.loadMore()}
                  disabled={docs.loadingMore || docs.loading}>
                  {docs.loadingMore ? 'Loading…' : `Load more (${docs.documents.length} of ${docs.totalCount} shown)`}
                </button>
              </div>
            )}
          </div>
        )
      )}

      {uploadOpen && (
        <UploadDialog
          onUpload={docs.upload}
          onClose={closeUpload}
          onUploaded={(d) => { closeUpload(); setNotice(`Uploaded ${d?.original_name || 'document'}. Processing has started.`); }}
        />
      )}
    </div>
  );
}

function Select({ id, label, value, onChange, options }) {
  return (
    <>
      <label className="visually-hidden" htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </>
  );
}

function DocumentRow({ doc, writable, docs, uploader, onError }) {
  const [editing, setEditing] = useState(false);
  const displayName = doc.filename || doc.original_name;
  return (
    <tr>
      <td className="cell-name">
        {editing ? (
          <RenameForm doc={doc} onRename={docs.rename} onDone={() => setEditing(false)} onError={onError} />
        ) : (
          <Link to={`/documents/${doc.id}`} title={displayName}>
            <Icon name="fileText" className="text-muted" />
            <span className="truncate">{displayName}</span>
          </Link>
        )}
      </td>
      <td className="hide-sm">{fileTypeLabel(doc.mime_type)}</td>
      <td className="hide-sm">{formatBytes(doc.file_size)}</td>
      <td className="hide-md">{uploader}</td>
      <td className="hide-md">{formatDateTime(doc.created_at)}</td>
      <td><StatusBadge status={doc.status} /></td>
      <td className="cell-actions">
        {!editing && (
          <DocumentActions doc={doc} writable={writable} actions={docs} onError={onError}
            onStartRename={() => setEditing(true)} />
        )}
      </td>
    </tr>
  );
}

