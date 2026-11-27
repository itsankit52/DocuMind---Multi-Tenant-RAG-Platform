/**
 * Phase 3.2C (F3) — the REAL InvitePage → invitationApi → axios path (no endpoint mocks):
 * preview is POST /invitations/preview with the token only in the JSON body, never in a URL,
 * never in storage or logs; accept keeps POST /invitations/accept { token }.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { http } from '../api/client';
import { clearPendingInvitationToken } from '../invitations/invitationToken';
import { AuthProvider } from '../context/AuthContext';
import { AppRoutes } from '../App';
import { UNAVAILABLE_TEXT } from '../pages/InvitePage';

const TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const USER = { id: 'u1', email: 'alice@example.com', fullName: 'Alice' };
const ORG = { organization_id: 'org-a', name: 'Acme', slug: 'acme', role: 'admin' };
const PREVIEW = { invitation: { organizationName: 'Beta Labs', role: 'viewer', inviterName: 'Bob Admin', expiresAt: '2026-12-01T10:00:00Z' } };
const ACCEPTED = { organization: { id: 'org-b', name: 'Beta Labs' }, membership: { role: 'viewer', status: 'active' } };

const originalAdapter = http.defaults.adapter;
let calls;

/** Stub the network: every request is recorded; `previewStatus` drives the preview response. */
function stubBackend({ previewStatus = 200 } = {}) {
  calls = [];
  http.defaults.adapter = async (config) => {
    calls.push(config);
    const ok = (body) => ({ status: 200, data: { status: 'success', data: body }, headers: {}, config, statusText: '' });
    const fail = (status, message) => {
      const err = new Error(`status ${status}`);
      err.response = { status, data: { status: 'fail', message }, headers: {}, config, statusText: '' };
      err.config = config;
      err.isAxiosError = true;
      throw err;
    };
    const url = config.url;
    if (url === '/auth/me') return ok({ user: USER, organizations: [ORG] });
    if (url.endsWith('/select')) return ok({ organizationId: ORG.organization_id, role: 'admin' });
    if (url === '/invitations/preview') {
      return previewStatus === 200 ? ok(PREVIEW) : fail(previewStatus, 'Invitation not found or no longer valid.');
    }
    if (url === '/invitations/accept') return ok(ACCEPTED);
    return ok({});
  };
}

function openInviteLink() {
  window.history.replaceState(null, '', `/invite#token=${TOKEN}`);
  return render(
    <MemoryRouter initialEntries={['/invite']}>
      <AuthProvider><AppRoutes /></AuthProvider>
    </MemoryRouter>,
  );
}

const consoleSpies = () => ['log', 'info', 'warn', 'error', 'debug'].map(m => vi.spyOn(console, m).mockImplementation(() => {}));
const invitationCalls = () => calls.filter(c => c.url.startsWith('/invitations/'));

function expectTokenOnlyInBodies(spies) {
  for (const c of calls) {
    const uri = http.getUri(c);
    expect(uri).not.toContain(TOKEN);
    expect(JSON.stringify(c.params ?? {})).not.toContain(TOKEN);
  }
  expect(window.location.href).not.toContain(TOKEN);
  expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN);
  for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
}

beforeEach(() => {
  clearPendingInvitationToken();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  http.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe('invitation preview transport (F3)', () => {
  it('preview is a POST with the token only in the JSON body; accept keeps its contract', async () => {
    const spies = consoleSpies();
    stubBackend();
    const user = userEvent.setup();
    openInviteLink();

    expect(await screen.findByText(/Beta Labs/)).toBeInTheDocument();
    const [preview] = invitationCalls();
    expect(preview.method).toBe('post');
    expect(preview.url).toBe('/invitations/preview');
    expect(JSON.parse(preview.data)).toEqual({ token: TOKEN });
    expect(preview.params).toBeUndefined();
    expect(http.getUri(preview)).not.toContain('?');

    await user.click(screen.getByRole('button', { name: /accept/i }));
    await vi.waitFor(() => expect(invitationCalls()).toHaveLength(2));
    const accept = invitationCalls()[1];
    expect(accept.method).toBe('post');
    expect(accept.url).toBe('/invitations/accept');
    expect(JSON.parse(accept.data)).toEqual({ token: TOKEN });

    // No GET ever targets the invitation endpoints
    expect(invitationCalls().every(c => c.method === 'post')).toBe(true);
    expectTokenOnlyInBodies(spies);
  });

  it('an invalid invitation still shows the neutral unavailable state, with no token leakage', async () => {
    const spies = consoleSpies();
    stubBackend({ previewStatus: 404 });
    openInviteLink();

    expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    const [preview] = invitationCalls();
    expect(preview.method).toBe('post');
    expect(JSON.parse(preview.data)).toEqual({ token: TOKEN });
    expect(invitationCalls().some(c => c.url === '/invitations/accept')).toBe(false);
    expectTokenOnlyInBodies(spies);
  });
});
