/**
 * Shared pieces of the Documents list and the document details page: the upload dialog, the
 * per-document actions (view, download, rename, retry, delete) and uploader names.
 * Permissions are UI hints only — the backend authorizes every call.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { organizationApi } from '../api/endpoints';
import { canManageMembers } from '../context/AuthContext';
import { downloadDocument } from '../hooks/useDocuments';
import { ACCEPTED_UPLOAD_EXTENSIONS, MAX_UPLOAD_MB, checkUploadFile, formatBytes } from '../utils/format';
import { Alert } from './Feedback';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** Upload dialog: choose one PDF/DOCX file, upload with progress. Validation mirrors the backend. */
export function UploadDialog({ onUpload, onUploaded, onClose }) {
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
      onUploaded(doc);
    } catch (err) {
      setError(err);
      setProgress(null);
    }
  };

  return (
    <Modal title="Upload document" onClose={onClose} closeDisabled={uploading}>
      <form onSubmit={onSubmit} aria-label="Upload document" noValidate>
        <p className="muted small">
          Uploaded documents are processed and indexed so your organization can ask questions about them.
        </p>
        {/* input first so its focus ring can be drawn on the visible label (input:focus-visible + .dropzone) */}
        <input ref={inputRef} id="upload-input" type="file" accept={ACCEPTED_UPLOAD_EXTENSIONS}
          onChange={onChoose} disabled={uploading} className="visually-hidden" />
        <label className="dropzone" htmlFor="upload-input">
          <Icon name="upload" size={20} />
          <strong>Upload a document (PDF or DOCX)</strong>
          <span>Up to {MAX_UPLOAD_MB} MB · click to choose a file</span>
        </label>
        {file && (
          <div className="dropzone-file">
            <Icon name="fileText" className="text-muted" />
            <span className="truncate flex-1" title={file.name}>{file.name}</span>
            <span className="muted small shrink-0">{formatBytes(file.size)}</span>
          </div>
        )}
        {uploading && (
          <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
        )}
        <Alert error={error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={uploading}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!file || uploading || !!checkUploadFile(file)}>
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Icon actions for one document. `onRename` starts renaming (the caller owns the form);
 * `actions` is { rename, remove, reprocess } from useDocuments or the details page.
 */
export function DocumentActions({ doc, writable, actions, onError, onStartRename, onDeleted, showView = true }) {
  const [busy, setBusy] = useState(null);
  const name = doc.filename || doc.original_name;
  const run = async (label, fn) => {
    setBusy(label);
    onError(null);
    try { await fn(); } catch (err) { onError(err); setBusy(null); return; }
    setBusy(null);
  };
  const onDelete = () => {
    if (!window.confirm(`Delete "${doc.original_name || doc.filename}"? This cannot be undone.`)) return;
    run('delete', async () => { await actions.remove(doc.id); onDeleted?.(); });
  };

  return (
    <span className="row-actions">
      {showView && (
        <Link to={`/documents/${doc.id}`} className="btn btn-icon" aria-label={`View ${name}`} title="View details">
          <Icon name="eye" />
        </Link>
      )}
      <button type="button" className="btn btn-icon" disabled={!!busy} title="Download"
        onClick={() => run('download', () => downloadDocument(doc))} aria-label={`Download ${name}`}>
        {busy === 'download' ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
      </button>
      {writable && onStartRename && (
        <button type="button" className="btn btn-icon" disabled={!!busy} title="Rename"
          onClick={onStartRename} aria-label={`Rename ${name}`}>
          <Icon name="pencil" />
        </button>
      )}
      {writable && doc.status === 'failed' && (
        <button type="button" className="btn btn-icon" disabled={!!busy} title="Retry processing"
          onClick={() => run('reprocess', () => actions.reprocess(doc.id))} aria-label={`Retry processing ${name}`}>
          <Icon name="refresh" />
        </button>
      )}
      {writable && (
        <button type="button" className="btn btn-icon hover:!text-danger" disabled={!!busy} title="Delete"
          onClick={onDelete} aria-label={`Delete ${name}`}>
          {busy === 'delete' ? <span className="spinner" aria-hidden="true" /> : <Icon name="trash" />}
        </button>
      )}
    </span>
  );
}

/** Inline rename form shared by the table row and the details page. */
export function RenameForm({ doc, onRename, onDone, onError }) {
  const [name, setName] = useState(doc.filename || '');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const next = name.trim();
    if (!next || next === doc.filename) return onDone();
    setSaving(true);
    onError(null);
    try {
      await onRename(doc.id, next);
      onDone();
    } catch (err) {
      onError(err);
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} className="inline-form">
      <label className="visually-hidden" htmlFor={`rename-${doc.id}`}>New name</label>
      <input id={`rename-${doc.id}`} className="input input-sm" value={name} autoFocus
        onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Escape' && onDone()} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>Save</button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>Cancel</button>
    </form>
  );
}

/**
 * user id → display name for "Uploaded by". Only admins can list members (backend-enforced),
 * so other roles see "You" for their own uploads and "Team member" otherwise.
 */
export function useUploaderNames(orgId, role, currentUserId) {
  const [names, setNames] = useState({});
  const admin = canManageMembers(role);
  useEffect(() => {
    if (!admin || !orgId) return undefined;
    let alive = true;
    Promise.resolve().then(() => organizationApi.listMembers(orgId))
      .then(r => alive && setNames(Object.fromEntries((r?.members || []).map(m => [m.id, m.full_name || m.email]))))
      .catch(() => {}); // names are a nicety; the table still works without them
    return () => { alive = false; setNames({}); };
  }, [orgId, admin]);
  return (userId) => {
    if (!userId) return '—';
    if (userId === currentUserId) return 'You';
    return names[userId] || 'Team member';
  };
}
