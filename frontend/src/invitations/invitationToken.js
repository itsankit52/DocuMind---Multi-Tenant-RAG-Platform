/**
 * Pending invitation token — held in MODULE MEMORY only.
 *
 * Invitation links look like /invite#token=RAW_TOKEN. The fragment never reaches a server;
 * we read it once, immediately remove it from the address bar (history.replaceState), and
 * keep the token in this module variable for the rest of the in-app flow (sign-in /
 * registration are client-side navigations, so it survives them).
 *
 * Deliberately NOT stored in localStorage, sessionStorage, cookies, React Router state
 * (persisted by the browser in history.state) or any URL. A full page reload therefore
 * forgets it — the invitee simply reopens the link. Never log this value.
 */

// Exactly the backend's format: 32 random bytes, base64url, unpadded (43 characters).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

let pendingToken = null;

export function isValidInvitationToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** Token from a "#token=…" fragment string, or null. */
function tokenFromFragment(fragment) {
  const raw = String(fragment || '').replace(/^#/, '');
  if (!raw) return null;
  return new URLSearchParams(raw).get('token');
}

/**
 * Read the token from window.location.hash (if any), remove the fragment from the visible URL,
 * and keep a valid token in memory. Safe to call repeatedly (React StrictMode).
 * @returns {'none' | 'captured' | 'malformed'}
 */
export function captureInvitationFromUrl(win = window) {
  const { hash, pathname, search } = win.location;
  if (!hash) return 'none';
  const token = tokenFromFragment(hash);
  if (token === null) return 'none';
  // Remove the token from the address bar first, whatever its validity.
  win.history.replaceState(win.history.state, '', `${pathname}${search}`);
  if (!isValidInvitationToken(token)) return 'malformed';
  pendingToken = token;
  return 'captured';
}

/**
 * Accept a pasted invitation link (…/invite#token=…) or a bare token. Only the token is
 * kept: no organization name or ID is ever accepted. Returns whether it was valid.
 */
export function setPendingInvitationFromLink(input) {
  const text = String(input || '').trim();
  let token = text;
  const hashIndex = text.indexOf('#');
  if (hashIndex >= 0) token = tokenFromFragment(text.slice(hashIndex));
  if (!isValidInvitationToken(token)) return false;
  pendingToken = token;
  return true;
}

export function getPendingInvitationToken() {
  return pendingToken;
}

export function clearPendingInvitationToken() {
  pendingToken = null;
}
