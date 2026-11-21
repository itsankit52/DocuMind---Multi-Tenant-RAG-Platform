import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toApiError } from '../api/client';
import { authApi, conversationApi, documentApi, organizationApi } from './apiMock';
import { mockSignedIn, ORG_A, renderApp, resetApiMocks, USER } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

const doc = { id: 'd1', filename: 'policy.pdf', original_name: 'policy.pdf', mime_type: 'application/pdf',
  file_size: 1000, status: 'ready', created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z' };

const MEMBERS = [
  { id: USER.id, email: USER.email, full_name: 'Alice', role: 'admin', status: 'active', created_at: '2026-09-01T10:00:00Z' },
  { id: 'u2', email: 'bob@example.com', full_name: 'Bob', role: 'member', status: 'active', created_at: '2026-09-02T10:00:00Z' },
  { id: 'u3', email: 'vic@example.com', full_name: 'Vic', role: 'viewer', status: 'active', created_at: '2026-09-03T10:00:00Z' },
];

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));

beforeEach(() => resetApiMocks());

describe('Role-aware navigation', () => {
  it.each([
    ['admin', 'Admin', true],
    ['member', 'Member', false],
    ['viewer', 'Viewer', false],
  ])('%s sees the role badge and the right navigation', async (role, label, hasMembers) => {
    mockSignedIn({ role });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.getAllByTestId('role-badge')[0]).toHaveTextContent(label);
    for (const item of ['Dashboard', 'Documents', 'Conversations']) {
      expect(nav().getByRole('link', { name: item })).toBeInTheDocument();
    }
    expect(nav().queryByRole('link', { name: 'Members' }) !== null).toBe(hasMembers);
  });

  it.each(['member', 'viewer'])('%s opening the Members URL directly gets "Not available" and no API call', async (role) => {
    mockSignedIn({ role });
    renderApp('/settings/members');
    expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
    expect(organizationApi.listMembers).not.toHaveBeenCalled();
  });

  it('role comes from the backend membership, not from login input', async () => {
    authApi.me.mockRejectedValueOnce(toApiError(401));
    authApi.login.mockResolvedValue({ user: USER });
    mockSignedIn({ role: 'viewer' });
    renderApp('/login');
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(authApi.login).toHaveBeenCalledWith({ email: 'alice@example.com', password: 'Password123!' });
    expect(screen.getAllByTestId('role-badge')[0]).toHaveTextContent('Viewer');
  });
});

describe('Role-aware actions', () => {
  it('viewer can download and ask questions but sees no modification actions', async () => {
    mockSignedIn({ role: 'viewer' });
    documentApi.list.mockResolvedValue({ documents: [doc], pagination: { totalCount: 1 } });
    conversationApi.list.mockResolvedValue({ conversations: [{ id: 'c1', title: 'Leave', updated_at: '2026-09-20T10:00:00Z' }] });
    conversationApi.get.mockResolvedValue({ conversation: { id: 'c1', title: 'Leave' }, messages: [] });

    renderApp('/documents');
    expect(await screen.findByRole('button', { name: 'Download policy.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename policy.pdf' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete policy.pdf' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Upload a document/)).not.toBeInTheDocument();

    await userEvent.setup().click(nav().getByRole('link', { name: 'Conversations' }));
    await userEvent.setup().click(await screen.findByRole('link', { name: /Leave/ }));
    const box = await screen.findByLabelText('Ask a question');
    await waitFor(() => expect(box).toBeEnabled());
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename Leave' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Leave' })).not.toBeInTheDocument();
  });

  it('member can upload, rename and delete but has no organization settings', async () => {
    mockSignedIn({ role: 'member' });
    documentApi.list.mockResolvedValue({ documents: [doc], pagination: { totalCount: 1 } });
    renderApp('/documents');
    expect(await screen.findByRole('button', { name: 'Rename policy.pdf' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Upload a document/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete policy.pdf' })).toBeInTheDocument();
    expect(nav().queryByRole('link', { name: 'Members' })).not.toBeInTheDocument();
  });

  it('a hidden action forced through still shows the backend rejection (403)', async () => {
    mockSignedIn({ role: 'member' });
    documentApi.list.mockResolvedValue({ documents: [doc], pagination: { totalCount: 1 } });
    documentApi.remove.mockRejectedValue(toApiError(403, 'raw'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/documents');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete policy.pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission');
    expect(screen.getByText('policy.pdf')).toBeInTheDocument();
  });
});

describe('Members page (admin)', () => {
  beforeEach(() => {
    mockSignedIn({ role: 'admin' });
    organizationApi.listMembers.mockResolvedValue({ members: MEMBERS });
  });

  it('lists members with name, email, role and status', async () => {
    renderApp('/settings/members');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(4);
    const bob = within(rows[2]);
    expect(bob.getByText('Bob')).toBeInTheDocument();
    expect(bob.getByText('bob@example.com')).toBeInTheDocument();
    expect(bob.getByLabelText('Role for bob@example.com')).toHaveValue('member');
    expect(bob.getByText('active')).toBeInTheDocument();
    expect(organizationApi.listMembers).toHaveBeenCalledWith(ORG_A.organization_id);
  });

  it('changes a member role through the existing API and refreshes the list', async () => {
    organizationApi.saveMember.mockResolvedValue({ membership: {} });
    renderApp('/settings/members');
    const select = await screen.findByLabelText('Role for bob@example.com');
    organizationApi.listMembers.mockResolvedValue({ members: MEMBERS.map(m => (m.id === 'u2' ? { ...m, role: 'viewer' } : m)) });
    await userEvent.setup().selectOptions(select, 'viewer');
    expect(organizationApi.saveMember).toHaveBeenCalledWith(ORG_A.organization_id, { email: 'bob@example.com', role: 'viewer' });
    expect(await screen.findByText('Bob is now Viewer.')).toBeInTheDocument();
    expect(screen.getByLabelText('Role for bob@example.com')).toHaveValue('viewer');
    expect(organizationApi.listMembers).toHaveBeenCalledTimes(2);
  });

  it('prevents demoting the last admin', async () => {
    renderApp('/settings/members');
    const self = await screen.findByLabelText(`Role for ${USER.email}`);
    expect(within(self).getByRole('option', { name: 'Member' })).toBeDisabled();
    expect(within(self).getByRole('option', { name: 'Viewer' })).toBeDisabled();
    expect(screen.getByText('Last admin')).toBeInTheDocument();
  });

  it('self-demotion (with another admin) asks first, then refreshes permissions and leaves admin UI', async () => {
    const twoAdmins = MEMBERS.map(m => (m.id === 'u2' ? { ...m, role: 'admin' } : m));
    organizationApi.listMembers.mockResolvedValue({ members: twoAdmins });
    organizationApi.saveMember.mockResolvedValue({ membership: {} });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/settings/members');
    const self = await screen.findByLabelText(`Role for ${USER.email}`);
    authApi.me.mockResolvedValue({ user: USER, organizations: [{ ...ORG_A, role: 'member' }] });
    await userEvent.setup().selectOptions(self, 'member');
    expect(confirm).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
    expect(nav().queryByRole('link', { name: 'Members' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('role-badge')[0]).toHaveTextContent('Member');
  });

  it('shows the backend error if a role change is rejected and reloads the real state', async () => {
    organizationApi.saveMember.mockRejectedValue(toApiError(409, 'An organization must keep at least one admin.'));
    renderApp('/settings/members');
    await userEvent.setup().selectOptions(await screen.findByLabelText('Role for bob@example.com'), 'admin');
    expect(await screen.findByRole('alert')).toHaveTextContent('An organization must keep at least one admin.');
    await waitFor(() => expect(organizationApi.listMembers).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Role for bob@example.com')).toHaveValue('member');
  });

  it('adds a registered user by email with a role', async () => {
    organizationApi.saveMember.mockResolvedValue({ membership: {} });
    renderApp('/settings/members');
    const user = userEvent.setup();
    const form = within(await screen.findByRole('form', { name: 'Add member' }));
    await user.type(form.getByLabelText('Email'), 'new@example.com');
    await user.selectOptions(form.getByLabelText('Role'), 'viewer');
    await user.click(form.getByRole('button', { name: 'Add member' }));
    expect(organizationApi.saveMember).toHaveBeenCalledWith(ORG_A.organization_id, { email: 'new@example.com', role: 'viewer' });
    expect(await screen.findByText('new@example.com was added as Viewer.')).toBeInTheDocument();
  });

  it('shows the backend reason when the user is not registered', async () => {
    organizationApi.saveMember.mockRejectedValue(toApiError(404, 'User with email x@example.com not found. They must register first.'));
    renderApp('/settings/members');
    const user = userEvent.setup();
    const form = within(await screen.findByRole('form', { name: 'Add member' }));
    await user.type(form.getByLabelText('Email'), 'x@example.com');
    await user.click(form.getByRole('button', { name: 'Add member' }));
    expect(await form.findByRole('alert')).toHaveTextContent('They must register first.');
  });
});
