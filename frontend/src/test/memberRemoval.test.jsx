import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toApiError } from '../api/client';
import { authApi, organizationApi } from './apiMock';
import { mockSignedIn, ORG_A, renderApp, resetApiMocks, USER } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

const MEMBERS = [
  { id: USER.id, email: USER.email, full_name: 'Alice', role: 'admin', status: 'active', created_at: '2026-09-01T10:00:00Z' },
  { id: 'u2', email: 'bob@example.com', full_name: 'Bob', role: 'member', status: 'active', created_at: '2026-09-02T10:00:00Z' },
];

beforeEach(() => {
  resetApiMocks();
  mockSignedIn({ role: 'admin' });
  organizationApi.listMembers.mockResolvedValue({ members: MEMBERS });
});

describe('Removing members', () => {
  it('removes a member after confirmation and refreshes the list', async () => {
    organizationApi.removeMember.mockResolvedValue({ removed: { userId: 'u2', role: 'member' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/settings/members');
    const button = await screen.findByRole('button', { name: 'Remove bob@example.com' });
    organizationApi.listMembers.mockResolvedValue({ members: [MEMBERS[0]] });
    await userEvent.setup().click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remove Bob'));
    expect(organizationApi.removeMember).toHaveBeenCalledWith(ORG_A.organization_id, 'u2');
    expect(await screen.findByText('Bob was removed from the organization.')).toBeInTheDocument();
    expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp('/settings/members');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Remove bob@example.com' }));
    expect(organizationApi.removeMember).not.toHaveBeenCalled();
  });

  it('cannot remove the last admin', async () => {
    renderApp('/settings/members');
    expect(await screen.findByRole('button', { name: `Remove ${USER.email}` })).toBeDisabled();
  });

  it('shows the backend error and reloads the real state', async () => {
    organizationApi.removeMember.mockRejectedValue(toApiError(409, 'An organization must keep at least one admin.'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/settings/members');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Remove bob@example.com' }));
    expect(await screen.findByText('An organization must keep at least one admin.')).toBeInTheDocument();
    await waitFor(() => expect(organizationApi.listMembers).toHaveBeenCalledTimes(2));
  });

  it('removing yourself (with another admin) refreshes the session and leaves the admin page', async () => {
    organizationApi.listMembers.mockResolvedValue({ members: MEMBERS.map(m => ({ ...m, role: 'admin' })) });
    organizationApi.removeMember.mockResolvedValue({ removed: { userId: USER.id, role: 'admin' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/settings/members');
    const button = await screen.findByRole('button', { name: `Remove ${USER.email}` });
    authApi.me.mockResolvedValue({ user: USER, organizations: [] });
    await userEvent.setup().click(button);
    expect(organizationApi.removeMember).toHaveBeenCalledWith(ORG_A.organization_id, USER.id);
    await waitFor(() => expect(authApi.me).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument());
  });
});
