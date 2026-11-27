/**
 * Google OAuth configuration rules (kept separate from env.js so they can be unit-tested).
 *
 *  - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL are optional as a group:
 *    all unset/empty → Google sign-in disabled (the endpoints answer "not configured").
 *    Some but not all set → configuration error (refuse to start rather than half-work).
 *  - GOOGLE_CALLBACK_URL: an absolute http(s) URL ending in /api/auth/google/callback, with no
 *    credentials, query or fragment. Production: https only, never a loopback host.
 *  - Enabled Google sign-in requires APP_BASE_URL (the frontend origin the callback returns
 *    the browser to). The frontend URL is never derived from request headers.
 * Values are never included in error messages.
 */

const CALLBACK_PATH = '/api/auth/google/callback';
const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL'];

const isSet = (v) => typeof v === 'string' && v.trim() !== '';
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/i;

/**
 * @param {object} data  parsed environment ({ GOOGLE_*, APP_BASE_URL (normalized), NODE_ENV })
 * @returns {{ enabled: boolean, issues: Array<{ path: string, message: string }> }}
 */
function checkGoogleOAuthConfig(data) {
  const present = KEYS.filter(k => isSet(data[k]));
  if (present.length === 0) return { enabled: false, issues: [] };
  if (present.length !== KEYS.length) {
    const missing = KEYS.filter(k => !present.includes(k));
    return {
      enabled: false,
      issues: missing.map(k => ({ path: k, message: `${k} is required when Google sign-in is configured (set all of ${KEYS.join(', ')} or none)` })),
    };
  }

  const issues = [];
  const raw = data.GOOGLE_CALLBACK_URL;
  let url = null;
  try { url = new URL(raw); } catch { /* reported below */ }
  if (!url || raw !== raw.trim() || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || url.pathname !== CALLBACK_PATH) {
    issues.push({ path: 'GOOGLE_CALLBACK_URL', message: `GOOGLE_CALLBACK_URL must be an absolute http(s) URL ending in ${CALLBACK_PATH}, without credentials, query or fragment` });
  } else if (data.NODE_ENV === 'production' && (url.protocol !== 'https:' || LOOPBACK.test(url.hostname))) {
    issues.push({ path: 'GOOGLE_CALLBACK_URL', message: 'GOOGLE_CALLBACK_URL must use https and a public host in production' });
  }
  if (!data.APP_BASE_URL) {
    issues.push({ path: 'APP_BASE_URL', message: 'APP_BASE_URL (the frontend origin) is required when Google sign-in is configured' });
  }
  return { enabled: issues.length === 0, issues };
}

module.exports = { checkGoogleOAuthConfig, CALLBACK_PATH };
