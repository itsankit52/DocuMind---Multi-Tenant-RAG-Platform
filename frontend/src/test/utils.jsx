import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { AppRoutes } from '../App';
import { ApiError } from '../api/client';
import { authApi, conversationApi, documentApi, invitationApi, organizationApi } from './apiMock';

export const USER = { id: 'u1', email: 'alice@example.com', fullName: 'Alice' };
export const ORG_A = { organization_id: 'org-a', name: 'Acme', slug: 'acme', role: 'admin' };

export const unauthorized = () => new ApiError(401, 'Your session has expired. Please sign in again.');

/** Default backend state: signed-in admin of one org with empty lists. */
export function mockSignedIn({ role = 'admin', organizations } = {}) {
  authApi.me.mockResolvedValue({ user: USER, organizations: organizations || [{ ...ORG_A, role }] });
  organizationApi.select.mockResolvedValue({ organizationId: ORG_A.organization_id, role });
  documentApi.list.mockResolvedValue({ documents: [], pagination: { totalCount: 0 } });
  conversationApi.list.mockResolvedValue({ conversations: [], pagination: { totalCount: 0 } });
  invitationApi.list.mockResolvedValue({ invitations: [], pagination: { page: 1, limit: 10, totalCount: 0, totalPages: 0 } });
}

export function resetApiMocks() {
  for (const api of [authApi, organizationApi, documentApi, conversationApi, invitationApi]) {
    for (const fn of Object.values(api)) fn.mockReset();
  }
  vi.restoreAllMocks();
}

export function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
