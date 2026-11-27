import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, toApiError } from '../api/client';
import { invitationApi } from '../api/endpoints';

const TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC';

/** Route axios requests to a stub instead of the network. */
function stubAdapter(handler) {
  const calls = [];
  http.defaults.adapter = async (config) => {
    calls.push(config);
    const { status, data = {}, networkError } = await handler(config);
    if (networkError) {
      const err = new Error('Network Error');
      err.config = config;
      err.request = {};
      err.isAxiosError = true;
      throw err;
    }
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
afterEach(() => {
  http.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe('invitation API wrappers', () => {
  it('use the backend routes and request formats', async () => {
    const calls = stubAdapter(() => ({ status: 200, data: { data: { ok: true } } }));
    await invitationApi.create('org-a', { email: 'x@example.com', role: 'viewer' });
    await invitationApi.list('org-a', { page: 2, limit: 10, status: 'pending' });
    await invitationApi.list('org-a', { page: 1, limit: 10 });
    await invitationApi.revoke('org-a', 'inv-1');
    await invitationApi.resend('org-a', 'inv-1');
    await invitationApi.preview(TOKEN);
    await expect(invitationApi.accept(TOKEN)).resolves.toEqual({ ok: true });

    const summary = calls.map(c => [c.method, c.url]);
    expect(summary).toEqual([
      ['post', '/organizations/org-a/invitations'],
      ['get', '/organizations/org-a/invitations'],
      ['get', '/organizations/org-a/invitations'],
      ['delete', '/organizations/org-a/invitations/inv-1'],
      ['post', '/organizations/org-a/invitations/inv-1/resend'],
      ['post', '/invitations/preview'],
      ['post', '/invitations/accept'],
    ]);
    expect(JSON.parse(calls[0].data)).toEqual({ email: 'x@example.com', role: 'viewer' });
    expect(calls[1].params).toEqual({ page: 2, limit: 10, status: 'pending' });
    expect(calls[2].params).toEqual({ page: 1, limit: 10 });
    // Preview: token ONLY in the JSON body — no query params, nothing in the URL
    expect(JSON.parse(calls[5].data)).toEqual({ token: TOKEN });
    expect(calls[5].params).toBeUndefined();
    expect(http.getUri(calls[5])).not.toContain(TOKEN);
    expect(http.getUri(calls[5])).not.toContain('?');
    // Accept sends ONLY the token
    expect(JSON.parse(calls[6].data)).toEqual({ token: TOKEN });
    expect(calls.every(c => c.withCredentials === true)).toBe(true);
  });

  it('keeps the backend error code (e.g. ALREADY_ORGANIZATION_MEMBER) and ignores malformed codes', async () => {
    stubAdapter(() => ({ status: 409, data: { message: 'You are already a member of this organization.', code: 'ALREADY_ORGANIZATION_MEMBER' } }));
    const err = await invitationApi.accept(TOKEN).catch(e => e);
    expect(err).toMatchObject({ status: 409, code: 'ALREADY_ORGANIZATION_MEMBER' });
    expect(toApiError(409, 'x', 'not a code <script>').code).toBeNull();
    expect(toApiError(409, 'x').code).toBeNull();
  });

  it('error messages and dev logs never contain the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubAdapter(() => ({ networkError: true }));
    const err = await invitationApi.accept(TOKEN).catch(e => e);
    expect(err.status).toBe(0);
    expect(JSON.stringify({ message: err.message, code: err.code })).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);

    stubAdapter(() => ({ status: 500, data: { message: `boom ${TOKEN}` } }));
    const serverErr = await invitationApi.preview(TOKEN).catch(e => e);
    expect(serverErr.message).not.toContain(TOKEN);
  });
});
