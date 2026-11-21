/**
 * Central HTTP client for the DocuMind API.
 *
 * - Auth uses the backend's HTTP-only cookies. JavaScript never reads or stores tokens.
 * - X-Organization-Id is attached from the active organization, which is only ever set
 *   from memberships returned by the backend (see AuthContext). The backend re-validates
 *   membership on every request; this header is a selector, not an authority.
 * - On 401 the client performs ONE shared cookie refresh and retries the request once.
 *   If refresh fails, the registered session-expired handler runs (AuthContext logs out).
 * - Errors are normalized to ApiError with a user-safe message (no stacks/internals).
 */

import axios from 'axios';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

let activeOrganizationId = null;
let onSessionExpired = () => {};
let refreshPromise = null;

export function setActiveOrganizationId(id) {
  activeOrganizationId = id || null;
}

export function getActiveOrganizationId() {
  return activeOrganizationId;
}

export function setSessionExpiredHandler(handler) {
  onSessionExpired = typeof handler === 'function' ? handler : () => {};
}

/** Report that the cookie session could not be refreshed (used by non-axios callers such as SSE). */
export function notifySessionExpired() {
  onSessionExpired();
}

const SAFE_MESSAGES = {
  0: 'Unable to reach the server. Check your connection and try again.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested item was not found.',
  409: 'This request conflicts with the current state. Please try again.',
  413: 'The file is too large.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Something went wrong on the server. Please try again.',
  503: 'The service is temporarily unavailable. Please try again shortly.',
};

// Statuses whose server message is a validated, user-facing explanation.
const PASS_THROUGH = new Set([400, 404, 409, 413]);

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
  }
}

/** Convert any failure into an ApiError with a message that is safe to display. */
export function toApiError(status, serverMessage) {
  const s = Number(status) || 0;
  let message = SAFE_MESSAGES[s] || (s >= 500 ? SAFE_MESSAGES[500] : 'The request could not be completed.');
  if (PASS_THROUGH.has(s) && typeof serverMessage === 'string' && serverMessage.trim()) {
    message = serverMessage.trim().slice(0, 300);
  }
  return new ApiError(s, message);
}

export function normalizeError(err) {
  if (err instanceof ApiError) return err;
  if (axios.isCancel(err) || err?.name === 'AbortError' || err?.name === 'CanceledError') {
    const e = new ApiError(0, 'Request cancelled.');
    e.cancelled = true;
    return e;
  }
  if (err?.response) {
    return toApiError(err.response.status, err.response.data?.message);
  }
  if (import.meta.env.DEV && err) console.warn('[api] network error', err);
  return toApiError(0);
}

export const http = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: { Accept: 'application/json' },
});

http.interceptors.request.use((config) => {
  if (activeOrganizationId && !config.skipOrgHeader) {
    config.headers['X-Organization-Id'] = activeOrganizationId;
  }
  return config;
});

/** Refresh the cookie session once, shared by all concurrent callers. */
export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = http
      .post('/auth/refresh', null, { skipAuthRefresh: true, skipOrgHeader: true })
      .then(() => true)
      .catch(() => false)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

http.interceptors.response.use(
  (res) => res,
  async (err) => {
    const { config, response } = err;
    if (response?.status === 401 && config && !config.skipAuthRefresh && !config._retried) {
      const ok = await refreshSession();
      if (ok) {
        config._retried = true;
        return http(config);
      }
      onSessionExpired();
    }
    return Promise.reject(normalizeError(err));
  },
);
