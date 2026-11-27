/**
 * Accessible modal dialog: role="dialog" + aria-modal, labelled by its title, focus moves
 * into the dialog on open, Tab is kept inside it, Escape closes it, and focus returns to the
 * element that opened it.
 */

import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, closeDisabled = false }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    // First control in the body (e.g. the email field), not the header's close button
    const first = dialog?.querySelector('.modal-body')?.querySelector(FOCUSABLE);
    (first || dialog)?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && !closeDisabledRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose} disabled={closeDisabled}>×</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
