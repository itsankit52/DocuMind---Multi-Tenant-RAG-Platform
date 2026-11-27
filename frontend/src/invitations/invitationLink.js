/**
 * Which shareable invitation link the admin UI may show.
 *
 * Order (first match wins):
 *   1. The backend's inviteUrl (built from the backend's validated APP_BASE_URL).
 *   2. VITE_PUBLIC_APP_URL — the canonical frontend origin, fixed at BUILD time (never taken
 *      from a request, a header or user input). Optional; there is no default domain.
 *   3. The current origin — only in the Vite dev server (import.meta.env.DEV), where the
 *      page origin is by definition the app being developed. Never in a production build,
 *      so a preview/staging host can't silently mint links for itself.
 *   Otherwise: no link (null) — the UI explains that the application URL must be configured.
 *
 * Links always use the fragment form /invite#token=… (never a query parameter). Neither the
 * token nor the link is ever logged.
 */

/** A bare http(s) origin (optional single trailing slash), or null. Mirrors the backend rules. */
export function parseCanonicalOrigin(raw, { production = false } = {}) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || /[\s\\@?#]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (production && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin; // no trailing slash
}

function linkFor(origin, token) {
  return `${origin}/invite#token=${encodeURIComponent(token)}`;
}

/**
 * @param {{ inviteUrl?: string|null, token?: string|null }} result backend create/resend data
 * @param {{ configuredBase?: string, allowCurrentOrigin?: boolean, currentOrigin?: string, production?: boolean }} [options]
 * @returns {string|null}
 */
export function resolveInvitationLink({ inviteUrl, token } = {}, options = {}) {
  if (typeof inviteUrl === 'string' && inviteUrl.trim()) return inviteUrl.trim();
  if (typeof token !== 'string' || !token) return null;

  const {
    configuredBase = import.meta.env.VITE_PUBLIC_APP_URL,
    allowCurrentOrigin = Boolean(import.meta.env.DEV),
    currentOrigin = typeof window !== 'undefined' ? window.location.origin : '',
    production = Boolean(import.meta.env.PROD),
  } = options;

  const canonical = parseCanonicalOrigin(configuredBase, { production });
  if (canonical) return linkFor(canonical, token);

  if (allowCurrentOrigin) {
    const origin = parseCanonicalOrigin(currentOrigin);
    if (origin) return linkFor(origin, token);
  }
  return null;
}
