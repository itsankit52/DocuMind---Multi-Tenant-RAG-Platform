/**
 * APP_BASE_URL validation (public frontend origin used to build invitation links).
 *
 * Kept separate from env.js so the exact rules can be unit-tested: env.js validates
 * process.env once at require time and exits the process on failure.
 *
 * Rules:
 *  - unset or the empty string → unset (no invitation URL is generated). The empty string is
 *    what `APP_BASE_URL=` in an env file or `${APP_BASE_URL:-}` in compose produces.
 *  - otherwise it must be an http(s) ORIGIN: no credentials, path, query or fragment, no
 *    surrounding whitespace or backslashes. One trailing slash is accepted and removed.
 *  - production: https only, and never localhost / loopback / unspecified addresses.
 *  - the returned value is the normalized origin (URL#origin: lowercase host, default port
 *    removed, no trailing slash).
 * Never derived from request headers or CORS_ORIGIN.
 */

const INVALID = 'APP_BASE_URL must be an http(s) origin without credentials, path, query or fragment';

function isLoopbackOrLocal(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0') return true;
  // IPv6 loopback / unspecified, and IPv4-mapped loopback (WHATWG serializes ::ffff:127.0.0.1 as ::ffff:7f00:1)
  if (host === '::1' || host === '::') return true;
  if (/^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d+\.\d+\.\d+)$/.test(host)) return true;
  return false;
}

/**
 * @param {string|undefined} raw  value from the environment
 * @param {string} nodeEnv        'development' | 'test' | 'production'
 * @returns {{ value: string|undefined, error: string|null }}
 */
function parseAppBaseUrl(raw, nodeEnv) {
  if (raw === undefined || raw === '') return { value: undefined, error: null };
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.includes('\\')) {
    return { value: undefined, error: INVALID };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { value: undefined, error: INVALID };
  }

  const hasExtras = url.username !== '' || url.password !== '' || raw.includes('@')
    || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || raw.includes('?') || raw.includes('#'); // an empty "?" / "#" is dropped by URL; reject explicitly
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || hasExtras) {
    return { value: undefined, error: INVALID };
  }

  if (nodeEnv === 'production') {
    if (url.protocol !== 'https:') {
      return { value: undefined, error: 'APP_BASE_URL must use https in production' };
    }
    if (isLoopbackOrLocal(url.hostname)) {
      return { value: undefined, error: 'APP_BASE_URL must not be a localhost or loopback address in production' };
    }
  }

  return { value: url.origin, error: null };
}

module.exports = { parseAppBaseUrl };
