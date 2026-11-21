/**
 * Session-expiry notice through the REAL endpoints + axios interceptor (no endpoint mocks):
 * only the transport adapter is stubbed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, setActiveOrganizationId } from '../api/client';
import { ORG_A, USER, renderApp } from './utils';

const EXPIRED = 'Your session has expired. Please sign in again.';

/** Route axios requests to a stub instead of the network. */
function stubAdapter(handler) {
  const calls = [];
  http.defaults.adapter = async (config) => {
    calls.push(config.url);
    const { status, data = {} } = await handler(config);
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
  setActiveOrganizationId(null);
});

describe('Session expired notice', () => {
  it('is not shown to a brand-new anonymous visitor (initial /auth/me 401 and failed refresh)', async () => {
    const calls = stubAdapter(() => ({ status: 401 }));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    // The interceptor really did attempt (and fail) a refresh during bootstrap
    expect(calls).toEqual(expect.arrayContaining(['/auth/me', '/auth/refresh']));
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
  });

  it('is shown when a signed-in user\'s session expires and cannot be refreshed', async () => {
    const calls = stubAdapter((config) => {
      if (config.url === '/auth/me') return { status: 200, data: { data: { user: USER, organizations: [ORG_A] } } };
      return { status: 401 }; // every data request and the refresh fail
    });
    renderApp('/documents');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    await waitFor(() => expect(calls).toContain('/auth/refresh'));
  });
});
