export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const TYPE_LABELS = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
};

export function fileTypeLabel(mime) {
  return TYPE_LABELS[mime] || (mime ? mime.split('/').pop().toUpperCase() : '—');
}

// Backend document statuses: uploading → uploaded → processing → ready | failed
export const DOCUMENT_STATUS = {
  uploading: { label: 'Uploading', tone: 'pending' },
  uploaded: { label: 'Queued', tone: 'pending' },
  processing: { label: 'Processing', tone: 'pending' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export function documentStatus(status) {
  return DOCUMENT_STATUS[status] || { label: status || 'Unknown', tone: 'neutral' };
}

export function isDocumentPending(status) {
  return status === 'uploading' || status === 'uploaded' || status === 'processing';
}

// UX pre-check only; the backend validates type and size authoritatively.
export const ACCEPTED_UPLOAD_TYPES = Object.keys(TYPE_LABELS);
export const ACCEPTED_UPLOAD_EXTENSIONS = '.pdf,.docx';
export const MAX_UPLOAD_MB = Number(import.meta.env.VITE_MAX_UPLOAD_MB) || 10;

export function checkUploadFile(file) {
  if (!file) return 'Choose a file to upload.';
  const byExt = /\.(pdf|docx)$/i.test(file.name);
  if (!ACCEPTED_UPLOAD_TYPES.includes(file.type) && !byExt) return 'Only PDF and DOCX files are supported.';
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `Files must be ${MAX_UPLOAD_MB} MB or smaller.`;
  if (file.size === 0) return 'The file is empty.';
  return null;
}
