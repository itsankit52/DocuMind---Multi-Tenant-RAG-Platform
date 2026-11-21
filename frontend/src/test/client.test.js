import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, normalizeError, setActiveOrganizationId, setSessionExpiredHandler, toApiError } from '../api/client';

/** Route axios requests to a stub instead of the network. */
function stubAdapter(handler) {
  const calls = [];
  http.defaults.adapter = async (config) => {
    calls.push(config);
    const { status, data = {} } = await handler(config, calls.length);
    const response = { status, data, headers: {}, config, statusText: '' };
    if (status >= 200 && status < 300) return response;
    const err = new Error(`status ${status}`);
    err.response = response;
    err.config = config;
    err.isAxiosError = true;
    throw err;
  };
  return calls;
}

const originalAdapter = http.defaults.adapter;
beforeEach(() => setActiveOrganizationId('org-a'));
afterEach(() => {
  http.defaults.adapter = originalAdapter;
  setSessionExpiredHandler(null);
  setActiveOrganizationId(null);
});

describe('HTTP client', () => {
  it('sends cookies and the active organization header, but never an Authorization token', async () => {
    const calls = stubAdapter(() => ({ status: 200, data: { data: {} } }));
    await http.get('/documents');
    expect(calls[0].withCredentials).toBe(true);
    expect(calls[0].headers['X-Organization-Id']).toBe('org-a');
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('on 401 refreshes the cookie session once and retries the request', async () => {
    const calls = stubAdapter((config) => {
      if (config.url === '/auth/refresh') return { status: 200 };
      const retried = calls.filter(c => c.url === '/documents').length > 1;
      return retried ? { status: 200, data: { data: { ok: true } } } : { status: 401 };
    });
    const res = await http.get('/documents');
    expect(res.data.data.ok).toBe(true);
    expect(calls.map(c => c.url)).toEqual(['/documents', '/auth/refresh', '/documents']);
  });

  it('concurrent 401s share one refresh request', async () => {
    let docCalls = 0;
    const calls = stubAdapter(async (config) => {
      if (config.url === '/auth/refresh') {
        await new Promise(r => setTimeout(r, 10));
        return { status: 200 };
      }
      docCalls += 1;
      return docCalls <= 2 ? { status: 401 } : { status: 200, data: { data: {} } };
    });
    await Promise.all([http.get('/documents'), http.get('/documents')]);
    expect(calls.filter(c => c.url === '/auth/refresh')).toHaveLength(1);
  });

  it('when refresh fails the session-expired handler runs and a 401 ApiError is thrown', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    stubAdapter(() => ({ status: 401 }));
    await expect(http.get('/documents')).rejects.toMatchObject({ status: 401, name: 'ApiError' });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('normalizes server errors without leaking internals', async () => {
    stubAdapter(() => ({ status: 500, data: { message: 'relation "documents" does not exist', stack: 'Error\n at db.js:1' } }));
    const err = await http.get('/documents').catch(e => e);
    expect(err.message).toBe('Something went wrong on the server. Please try again.');
    expect(err.message).not.toMatch(/relation|stack/);
  });

  it('maps each status family to a user-friendly message', () => {
    expect(toApiError(400, 'Message content is required.').message).toBe('Message content is required.');
    expect(toApiError(403, 'raw').message).toMatch(/permission/);
    expect(toApiError(404, 'Conversation not found.').message).toBe('Conversation not found.');
    expect(toApiError(409, 'Key reused').message).toBe('Key reused');
    expect(toApiError(413).message).toMatch(/too large/);
    expect(toApiError(429, 'raw').message).toMatch(/Too many requests/);
    expect(toApiError(502).message).toMatch(/server/);
    expect(toApiError(0).message).toMatch(/reach the server/);
    expect(normalizeError(new TypeError('Network Error')).status).toBe(0);
  });
});
