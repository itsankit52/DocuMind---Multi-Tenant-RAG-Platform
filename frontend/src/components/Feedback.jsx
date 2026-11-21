/** Small shared status components: spinner, alerts, empty state, status badge. */

import { documentStatus } from '../utils/format';

export function Spinner({ label = 'Loading…', inline = false }) {
  return (
    <div className={inline ? 'spinner-inline' : 'spinner-block'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className={inline ? 'visually-hidden' : 'spinner-label'}>{label}</span>
    </div>
  );
}

export function FullPageLoader({ label = 'Loading DocuMind…' }) {
  return (
    <div className="full-page-center">
      <Spinner label={label} />
    </div>
  );
}

/** Shows only the normalized, user-safe message of an ApiError. */
export function Alert({ error, message, tone = 'danger', onRetry, onDismiss }) {
  const text = message || error?.message;
  if (!text) return null;
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span>{text}</span>
      <span className="alert-actions">
        {onRetry && <button type="button" className="btn btn-link" onClick={onRetry}>Retry</button>}
        {onDismiss && <button type="button" className="btn btn-link" onClick={onDismiss} aria-label="Dismiss">×</button>}
      </span>
    </div>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function StatusBadge({ status }) {
  const { label, tone } = documentStatus(status);
  return <span className={`badge badge-${tone}`} data-testid="doc-status">{label}</span>;
}
