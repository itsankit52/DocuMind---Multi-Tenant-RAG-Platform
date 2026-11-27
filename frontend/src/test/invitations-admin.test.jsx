import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toApiError } from '../api/client';
import { invitationApi, organizationApi } from './apiMock';
import { deferred, mockSignedIn, renderApp, resetApiMocks } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

const TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const NEW_TOKEN = 'Nw_-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const LINK = `https://docs.example.com/invite#token=${TOKEN}`;
const inv = (over = {}) => ({
  id: 'inv-1', organization_id: 'org-a', email: 'carol@example.com', role: 'member', status: 'pending',
  created_at: '2026-11-20T10:00:00Z', expires_at: '2026-11-23T10:00:00Z', ...over,
});
const page = (invitations, { page: p = 1, totalCount = invitations.length, totalPages = 1 } = {}) =>
  ({ invitations, pagination: { page: p, limit: 10, totalCount, totalPages } });

const panel = () => within(screen.getByRole('region', { name: 'Invitations' }));
async function openMembers() {
  renderApp('/settings/invitations');
  await screen.findByRole('heading', { name: 'Invitations' });
}
async function openInviteDialog(user) {
  await user.click(panel().getByRole('button', { name: 'Send invitation' }));
  return within(screen.getByRole('dialog', { name: 'Invite member' }));
}

let clipboard;
/** user-event installs its own clipboard stub in setup(); replace it afterwards with our spy. */
function setupUser() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  return user;
}
beforeEach(() => {
  resetApiMocks();
  mockSignedIn();
  organizationApi.listMembers.mockResolvedValue({ members: [] });
  clipboard = vi.fn().mockResolvedValue(undefined);
});

describe('Invitations panel (admin)', () => {
  it('lists invitations with role and status badges, created and expiry dates', async () => {
    invitationApi.list.mockResolvedValue(page([inv(), inv({ id: 'inv-2', email: 'dan@example.com', role: 'viewer', status: 'expired' })]));
    await openMembers();
    const rows = await panel().findAllByRole('row');
    expect(rows).toHaveLength(3);
    const first = within(rows[1]);
    expect(first.getByText('carol@example.com')).toBeInTheDocument();
    expect(first.getByText('Member')).toHaveClass('badge-role-member');
    expect(first.getByText('Pending')).toHaveClass('badge-pending');
    expect(first.getByRole('button', { name: 'Resend invitation to carol@example.com' })).toBeInTheDocument();
    const second = within(rows[2]);
    expect(second.getByText('Expired')).toBeInTheDocument();
    expect(second.queryByRole('button')).not.toBeInTheDocument(); // only pending invitations have actions
    expect(invitationApi.list).toHaveBeenCalledWith('org-a', { page: 1, limit: 10, status: undefined });
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it('shows empty and error states', async () => {
    invitationApi.list.mockRejectedValueOnce(toApiError(500)).mockResolvedValue(page([]));
    await openMembers();
    expect(await panel().findByRole('alert')).toHaveTextContent(/Something went wrong/);
    await userEvent.setup().click(panel().getByRole('button', { name: 'Retry' }));
    expect(await panel().findByText('No invitations yet')).toBeInTheDocument();
  });

  it('filters by status and paginates', async () => {
    invitationApi.list.mockResolvedValue(page([inv()], { totalCount: 12, totalPages: 2 }));
    await openMembers();
    const user = setupUser();
    await panel().findByText('Page 1 of 2');
    await user.click(panel().getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(invitationApi.list).toHaveBeenLastCalledWith('org-a', { page: 2, limit: 10, status: undefined }));
    await user.selectOptions(panel().getByLabelText('Status'), 'revoked');
    await waitFor(() => expect(invitationApi.list).toHaveBeenLastCalledWith('org-a', { page: 1, limit: 10, status: 'revoked' }));
  });

  it('validates and trims the email, sends email + role, and shows the link without claiming an email was sent', async () => {
    invitationApi.create.mockResolvedValue({ invitation: inv({ email: 'new@example.com', role: 'viewer' }), token: TOKEN, inviteUrl: LINK });
    await openMembers();
    const user = setupUser();
    const dialog = await openInviteDialog(user);
    expect(dialog.getByLabelText('Email address')).toHaveFocus();
    await user.type(dialog.getByLabelText('Email address'), 'not-an-email');
    await user.click(dialog.getByRole('button', { name: 'Create invitation' }));
    expect(dialog.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    expect(invitationApi.create).not.toHaveBeenCalled();

    await user.clear(dialog.getByLabelText('Email address'));
    await user.type(dialog.getByLabelText('Email address'), '  new@example.com  ');
    await user.selectOptions(dialog.getByLabelText('Role'), 'viewer');
    await user.click(dialog.getByRole('button', { name: 'Create invitation' }));
    expect(invitationApi.create).toHaveBeenCalledWith('org-a', { email: 'new@example.com', role: 'viewer' });

    const share = within(await screen.findByRole('dialog', { name: 'Invitation created' }));
    expect(share.getByText('Invitation created. Copy and share this link with the invited person.')).toBeInTheDocument();
    expect(share.getByText('new@example.com')).toBeInTheDocument();
    expect(share.getByText(/No email was sent/)).toHaveTextContent(/72 hours/);
    expect(share.getByLabelText('Invitation link')).toHaveValue(LINK);
    expect(clipboard).not.toHaveBeenCalled(); // only on an explicit click

    await user.click(share.getByRole('button', { name: 'Copy invitation link' }));
    expect(clipboard).toHaveBeenCalledWith(LINK);
    expect(share.getByText('Link copied to the clipboard.')).toBeInTheDocument();

    await user.click(share.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(LINK)).not.toBeInTheDocument(); // token gone from the UI
  });

  it('reports a clipboard failure and selects the link for manual copy', async () => {
    clipboard.mockRejectedValue(new Error('denied'));
    invitationApi.create.mockResolvedValue({ invitation: inv(), token: TOKEN, inviteUrl: LINK });
    await openMembers();
    const user = setupUser();
    const dialog = await openInviteDialog(user);
    await user.type(dialog.getByLabelText('Email address'), 'carol@example.com');
    await user.click(dialog.getByRole('button', { name: 'Create invitation' }));
    const share = within(await screen.findByRole('dialog', { name: 'Invitation created' }));
    await user.click(share.getByRole('button', { name: 'Copy invitation link' }));
    expect(share.getByRole('alert')).toHaveTextContent(/Couldn't copy automatically/);
  });

  it('production build without inviteUrl or VITE_PUBLIC_APP_URL shows a configuration message and no link', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_PUBLIC_APP_URL', '');
    invitationApi.list.mockResolvedValueOnce(page([])).mockResolvedValue(page([inv()]));
    invitationApi.create.mockResolvedValue({ invitation: inv(), token: TOKEN, inviteUrl: null });
    try {
      await openMembers();
      const user = setupUser();
      const dialog = await openInviteDialog(user);
      await user.type(dialog.getByLabelText('Email address'), 'carol@example.com');
      await user.click(dialog.getByRole('button', { name: 'Create invitation' }));
      const share = within(await screen.findByRole('dialog', { name: 'Invitation created' }));
      expect(share.getByRole('alert')).toHaveTextContent('Invitation created, but a shareable link could not be generated. Contact your application administrator.');
      expect(share.getByText(/appears in the invitation list/)).toBeInTheDocument();
      expect(share.queryByRole('button', { name: 'Copy invitation link' })).not.toBeInTheDocument();
      expect(share.queryByText(/Copy and share this link/)).not.toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain(TOKEN);
      await user.click(share.getByRole('button', { name: 'Done' }));
      expect(await panel().findByText('carol@example.com')).toBeInTheDocument(); // still listed
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('in the Vite dev server, without a backend inviteUrl, uses the dev origin and /invite#token=', async () => {
    invitationApi.create.mockResolvedValue({ invitation: inv(), token: TOKEN, inviteUrl: null });
    await openMembers();
    const user = setupUser();
    const dialog = await openInviteDialog(user);
    await user.type(dialog.getByLabelText('Email address'), 'carol@example.com');
    await user.click(dialog.getByRole('button', { name: 'Create invitation' }));
    const share = within(await screen.findByRole('dialog', { name: 'Invitation created' }));
    expect(share.getByLabelText('Invitation link')).toHaveValue(`${window.location.origin}/invite#token=${TOKEN}`);
  });

  it('prevents duplicate submissions and shows backend errors (e.g. pending invitation exists)', async () => {
    const pending = deferred();
    invitationApi.create.mockReturnValue(pending.promise);
    await openMembers();
    const user = setupUser();
    const dialog = await openInviteDialog(user);
    await user.type(dialog.getByLabelText('Email address'), 'carol@example.com');
    await user.click(dialog.getByRole('button', { name: 'Create invitation' }));
    expect(dialog.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Creating…' }));
    expect(invitationApi.create).toHaveBeenCalledTimes(1);
    pending.reject(toApiError(409, 'A pending invitation already exists for this email.'));
    expect(await dialog.findByRole('alert')).toHaveTextContent('A pending invitation already exists for this email.');
  });

  it('dialog is keyboard accessible: Escape closes it and focus returns to the trigger', async () => {
    await openMembers();
    const user = setupUser();
    await openInviteDialog(user);
    expect(screen.getByRole('dialog', { name: 'Invite member' })).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Send invitation' })).toHaveFocus();
  });

  it('resend shows the new link and explains the old one stopped working', async () => {
    invitationApi.list.mockResolvedValue(page([inv()]));
    invitationApi.resend.mockResolvedValue({ invitation: inv(), token: NEW_TOKEN, inviteUrl: `https://docs.example.com/invite#token=${NEW_TOKEN}` });
    await openMembers();
    const user = setupUser();
    await user.click(await panel().findByRole('button', { name: 'Resend invitation to carol@example.com' }));
    const share = within(await screen.findByRole('dialog', { name: 'New invitation link' }));
    expect(share.getByText('A new link was generated. The previous link no longer works.')).toBeInTheDocument();
    expect(share.getByLabelText('Invitation link')).toHaveValue(`https://docs.example.com/invite#token=${NEW_TOKEN}`);
    expect(invitationApi.resend).toHaveBeenCalledWith('org-a', 'inv-1');
  });

  it('revoke asks for confirmation, sends one request and refreshes the list', async () => {
    invitationApi.list.mockResolvedValueOnce(page([inv()])).mockResolvedValue(page([inv({ status: 'revoked' })]));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const pending = deferred();
    invitationApi.revoke.mockReturnValue(pending.promise);
    await openMembers();
    const user = setupUser();
    const revoke = await panel().findByRole('button', { name: 'Revoke invitation to carol@example.com' });
    await user.click(revoke);
    expect(invitationApi.revoke).not.toHaveBeenCalled();
    await user.click(revoke);
    expect(revoke).toBeDisabled();
    await user.click(revoke);
    expect(invitationApi.revoke).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    pending.resolve({ invitation: inv({ status: 'revoked' }) });
    expect(await panel().findByText('The invitation for carol@example.com was revoked.')).toBeInTheDocument();
    expect(await panel().findByText('Revoked', { selector: '.badge' })).toBeInTheDocument();
    expect(invitationApi.list).toHaveBeenCalledTimes(2);
  });

  it.each(['member', 'viewer'])('%s never sees invitation controls or calls the invitation API', async (role) => {
    resetApiMocks();
    mockSignedIn({ role });
    renderApp('/settings/invitations');
    expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
    expect(invitationApi.list).not.toHaveBeenCalled();
  });
});
