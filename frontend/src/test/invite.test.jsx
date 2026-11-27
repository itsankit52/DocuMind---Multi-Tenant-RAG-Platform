import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { notifySessionExpired, toApiError } from '../api/client';
import { clearPendingInvitationToken, getPendingInvitationToken } from '../invitations/invitationToken';
import { TRY_ANOTHER_ACCOUNT_TEXT, UNAVAILABLE_TEXT } from '../pages/InvitePage';
import { AuthProvider } from '../context/AuthContext';
import { AppRoutes } from '../App';
import { authApi, invitationApi } from './apiMock';
import { deferred, mockSignedIn, ORG_A, renderApp, resetApiMocks, unauthorized, USER } from './utils';

/** Records every router location state, so tests can prove the token never enters it. */
const routerStates = [];
function LocationProbe() {
  routerStates.push(useLocation().state);
  return null;
}
function openInviteLinkWithProbe(token = TOKEN) {
  window.history.replaceState(null, '', `/invite#token=${token}`);
  return render(
    <MemoryRouter initialEntries={['/invite']}>
      <AuthProvider><AppRoutes /><LocationProbe /></AuthProvider>
    </MemoryRouter>,
  );
}
const OTHER_USER = { id: 'u9', email: 'other@example.com', fullName: 'Other' };
async function signInAs(user, who) {
  await user.type(await screen.findByLabelText('Email'), who.email);
  await user.type(screen.getByLabelText('Password'), 'Password123!');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

vi.mock('../api/endpoints', () => import('./apiMock'));

const TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const ORG_B = { organization_id: 'org-b', name: 'Beta Labs', slug: 'beta', role: 'viewer' };
const PREVIEW = { invitation: { organizationName: 'Beta Labs', role: 'viewer', inviterName: 'Bob Admin', expiresAt: '2026-12-01T10:00:00Z' } };
const ACCEPTED = { organization: { id: 'org-b', name: 'Beta Labs' }, membership: { role: 'viewer', status: 'active' } };

/** Open /invite the way a browser does: the fragment is on window.location. */
function openInviteLink(token = TOKEN) {
  window.history.replaceState(null, '', `/invite#token=${token}`);
  return renderApp('/invite');
}
const expectNoTokenAnywhere = () => {
  expect(window.location.href).not.toContain(TOKEN);
  expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
  expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(TOKEN);
};

beforeEach(() => {
  routerStates.length = 0;
  resetApiMocks();
  clearPendingInvitationToken();
  window.history.replaceState(null, '', '/');
});

describe('/invite route', () => {
  it('signed out: removes the token from the URL, does not call the API and offers sign-in/registration', async () => {
    authApi.me.mockRejectedValue(unauthorized());
    openInviteLink();
    expect(await screen.findByRole('heading', { name: "You've been invited to DocuMind" })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expectNoTokenAnywhere();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument();
    expect(invitationApi.preview).not.toHaveBeenCalled();
    expect(invitationApi.accept).not.toHaveBeenCalled();
  });

  it('without a token in memory (e.g. after a refresh) asks to reopen the link', async () => {
    mockSignedIn();
    renderApp('/invite');
    expect(await screen.findByRole('heading', { name: 'Open your invitation link' })).toBeInTheDocument();
    expect(screen.getByText(/open the invitation link again/)).toBeInTheDocument();
    expect(invitationApi.preview).not.toHaveBeenCalled();
  });

  it('rejects a malformed token without calling the API', async () => {
    mockSignedIn();
    openInviteLink('not-a-real-token');
    expect(await screen.findByRole('heading', { name: 'Invalid invitation link' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(invitationApi.preview).not.toHaveBeenCalled();
  });

  it('sign-in continues to the preview with the in-memory token; normal sign-in still goes to the dashboard', async () => {
    authApi.me.mockRejectedValueOnce(unauthorized());
    authApi.login.mockResolvedValue({ user: USER });
    mockSignedIn();
    invitationApi.preview.mockResolvedValue(PREVIEW);
    openInviteLinkWithProbe();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Sign in' }));
    expect(await screen.findByText('Sign in to continue with your invitation.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), USER.email);
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Beta Labs')).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenCalledWith(TOKEN);
    expect(invitationApi.accept).not.toHaveBeenCalled();
    expectNoTokenAnywhere();
    expect(routerStates.some(st => st?.from === '/invite')).toBe(true);
    expect(JSON.stringify(routerStates)).not.toContain(TOKEN);
  });

  it('registration continues to the invitation, and accepting enters the new organization', async () => {
    authApi.me
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ user: USER, organizations: [] })
      .mockResolvedValue({ user: USER, organizations: [ORG_B] });
    authApi.register.mockResolvedValue({ user: USER });
    authApi.login.mockResolvedValue({ user: USER });
    invitationApi.preview.mockResolvedValue(PREVIEW);
    invitationApi.accept.mockResolvedValue(ACCEPTED);
    openInviteLink();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), USER.email);
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.type(screen.getByLabelText('Confirm password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText("You're now a member of Beta Labs.")).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('shows organization, inviter, role and expiry; preview never accepts', async () => {
    mockSignedIn();
    invitationApi.preview.mockResolvedValue(PREVIEW);
    openInviteLink();
    const details = within(await screen.findByRole('region', { name: 'Invitation details' }));
    expect(details.getByText('Beta Labs')).toBeInTheDocument();
    expect(details.getByText('Invited by Bob Admin')).toBeInTheDocument();
    expect(details.getByText('Viewer')).toBeInTheDocument();
    expect(details.getByText('Expires')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenCalledTimes(1);
    expect(invitationApi.accept).not.toHaveBeenCalled();
  });

  it('a generic 404 is neutral, never blames the account and never shows an invited email', async () => {
    mockSignedIn();
    invitationApi.preview.mockRejectedValue(toApiError(404, 'Invitation not found or no longer valid.'));
    const { container } = openInviteLink();
    expect(await screen.findByRole('heading', { name: 'Invitation unavailable' })).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(UNAVAILABLE_TEXT).toBe('This invitation is unavailable. It may be invalid, expired, revoked, or no longer active.');
    expect(screen.getByText(TRY_ANOTHER_ACCOUNT_TEXT)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/not available for the currently signed-in account|wrong account|incorrect account/i);
    // Only the signed-in user's own address is shown — no invited email exists in the UI
    expect(container.textContent).toContain(USER.email);
    expect(container.textContent.split(USER.email).join('')).not.toContain('@');
  });

  it('"Try another account" signs out via the existing flow, keeps the token in memory only, and continues', async () => {
    mockSignedIn();
    authApi.logout.mockResolvedValue({});
    authApi.login.mockResolvedValue({ user: OTHER_USER });
    invitationApi.preview.mockRejectedValueOnce(toApiError(404)).mockResolvedValueOnce(PREVIEW);
    openInviteLinkWithProbe();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try another account' }));
    expect(authApi.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Sign in to continue with your invitation.')).toBeInTheDocument();
    expect(getPendingInvitationToken()).toBe(TOKEN);
    expectNoTokenAnywhere();
    authApi.me.mockResolvedValue({ user: OTHER_USER, organizations: [ORG_A] });
    await signInAs(user, OTHER_USER);
    expect(await screen.findByText('Invited by Bob Admin')).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenLastCalledWith(TOKEN);
    expect(routerStates.length).toBeGreaterThan(0);
    expect(JSON.stringify(routerStates)).not.toContain(TOKEN);
    expectNoTokenAnywhere();
  });

  it('another account that also gets a 404 (e.g. expired) sees the same neutral message', async () => {
    mockSignedIn();
    authApi.logout.mockResolvedValue({});
    authApi.login.mockResolvedValue({ user: OTHER_USER });
    invitationApi.preview.mockRejectedValue(toApiError(404));
    openInviteLink();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try another account' }));
    authApi.me.mockResolvedValue({ user: OTHER_USER, organizations: [ORG_A] });
    await signInAs(user, OTHER_USER);
    expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(invitationApi.accept).not.toHaveBeenCalled();
  });

  it('a token cleared after an invalid acceptance is not resurrected by "Try another account"', async () => {
    mockSignedIn();
    authApi.logout.mockResolvedValue({});
    authApi.login.mockResolvedValue({ user: OTHER_USER });
    invitationApi.preview.mockResolvedValue(PREVIEW);
    invitationApi.accept.mockRejectedValue(toApiError(404));
    openInviteLink();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await user.click(await screen.findByRole('button', { name: 'Try another account' }));
    expect(getPendingInvitationToken()).toBeNull();
    authApi.me.mockResolvedValue({ user: OTHER_USER, organizations: [ORG_A] });
    await signInAs(user, OTHER_USER);
    expect(await screen.findByRole('heading', { name: 'Open your invitation link' })).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenCalledTimes(1);
    expect(getPendingInvitationToken()).toBeNull();
  });

  it.each([
    [429, /Too many requests/],
    [500, /Something went wrong/],
    [0, /Unable to reach the server/],
  ])('preview %s shows a safe error with a manual retry only', async (status, text) => {
    mockSignedIn();
    invitationApi.preview.mockRejectedValueOnce(toApiError(status)).mockResolvedValueOnce(PREVIEW);
    openInviteLink();
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(invitationApi.preview).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Beta Labs')).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenCalledTimes(2);
  });

  it('preview 401 (session expired) returns to the sign-in prompt and keeps the invitation', async () => {
    mockSignedIn();
    invitationApi.preview.mockImplementation(async () => { notifySessionExpired(); throw unauthorized(); });
    openInviteLink();
    expect(await screen.findByRole('heading', { name: "You've been invited to DocuMind" })).toBeInTheDocument();
    expect(invitationApi.accept).not.toHaveBeenCalled();
  });
});

describe('accepting an invitation', () => {
  async function openPreview({ organizations } = {}) {
    mockSignedIn({ organizations });
    invitationApi.preview.mockResolvedValue(PREVIEW);
    openInviteLink();
    return screen.findByRole('button', { name: 'Accept invitation' });
  }

  it('sends only the token once, refreshes memberships, activates the new org and keeps existing ones', async () => {
    const button = await openPreview();
    const pending = deferred();
    invitationApi.accept.mockReturnValue(pending.promise);
    authApi.me.mockResolvedValue({ user: USER, organizations: [ORG_A, ORG_B] });
    const user = userEvent.setup();
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Joining…' }));
    expect(screen.getByRole('button', { name: 'Joining…' })).toBeDisabled();
    expect(invitationApi.accept).toHaveBeenCalledTimes(1);
    expect(invitationApi.accept.mock.calls[0]).toEqual([TOKEN]);
    pending.resolve(ACCEPTED);

    expect(await screen.findByText("You're now a member of Beta Labs.")).toBeInTheDocument();
    const switcher = screen.getByLabelText('Organization');
    expect(switcher).toHaveValue('org-b');
    expect(within(switcher).getAllByRole('option').map(o => o.textContent)).toEqual(['Acme', 'Beta Labs']);
    // Viewer in the new org: role-based navigation updates immediately
    expect(screen.getAllByTestId('role-badge')[0]).toHaveTextContent('Viewer');
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Members' })).not.toBeInTheDocument();
    expectNoTokenAnywhere();
  });

  it('409 already-member shows an informative message', async () => {
    const button = await openPreview();
    const err = toApiError(409, 'You are already a member of this organization.', 'ALREADY_ORGANIZATION_MEMBER');
    invitationApi.accept.mockRejectedValue(err);
    await userEvent.setup().click(button);
    expect(await screen.findByRole('heading', { name: 'Already a member' })).toBeInTheDocument();
    expect(screen.getByText(/Your current role was not changed/)).toBeInTheDocument();
  });

  it('404 shows the generic unavailable message', async () => {
    const button = await openPreview();
    invitationApi.accept.mockRejectedValue(toApiError(404, 'Invitation not found or no longer valid.'));
    await userEvent.setup().click(button);
    expect(await screen.findByRole('heading', { name: 'Invitation unavailable' })).toBeInTheDocument();
  });

  it('429 asks to retry later and never retries automatically', async () => {
    const button = await openPreview();
    invitationApi.accept.mockRejectedValue(toApiError(429));
    await userEvent.setup().click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many requests/);
    await new Promise(r => setTimeout(r, 50));
    expect(invitationApi.accept).toHaveBeenCalledTimes(1);
  });

  it('500 shows a generic error and allows one manual retry', async () => {
    const button = await openPreview();
    invitationApi.accept.mockRejectedValueOnce(toApiError(500)).mockResolvedValueOnce(ACCEPTED);
    authApi.me.mockResolvedValue({ user: USER, organizations: [ORG_A, ORG_B] });
    const user = userEvent.setup();
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("You're now a member of Beta Labs.")).toBeInTheDocument();
    expect(invitationApi.accept).toHaveBeenCalledTimes(2);
  });

  it('401 during accept goes back to sign-in and keeps the invitation in memory', async () => {
    const button = await openPreview();
    invitationApi.accept.mockImplementation(async () => { notifySessionExpired(); throw unauthorized(); });
    await userEvent.setup().click(button);
    expect(await screen.findByRole('heading', { name: "You've been invited to DocuMind" })).toBeInTheDocument();
  });

  it('"Not now" leaves without accepting', async () => {
    const button = await openPreview();
    expect(button).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Not now' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(invitationApi.accept).not.toHaveBeenCalled();
  });
});

describe('onboarding', () => {
  it('offers Create and Join (invitation link only — no organization ID, name or search)', async () => {
    mockSignedIn({ organizations: [] });
    renderApp('/onboarding');
    expect(await screen.findByRole('heading', { name: 'Create your organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create organization' })).toBeInTheDocument();
    const join = within(screen.getByRole('region', { name: 'Join an organization' }));
    expect(join.getByText('Join an organization using an invitation link shared by its administrator.')).toBeInTheDocument();
    await userEvent.setup().click(join.getByRole('button', { name: 'I have an invitation link' }));
    expect(join.getAllByRole('textbox')).toHaveLength(1);
    expect(join.getByLabelText('Invitation link')).toBeInTheDocument();
    expect(join.queryByLabelText(/organization (id|name)/i)).not.toBeInTheDocument();
  });

  it('a pasted link opens the invitation; anything else is rejected without an API call', async () => {
    mockSignedIn({ organizations: [] });
    invitationApi.preview.mockResolvedValue(PREVIEW);
    renderApp('/onboarding');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'I have an invitation link' }));
    await user.type(screen.getByLabelText('Invitation link'), 'Beta Labs');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/complete invitation link/);
    expect(invitationApi.preview).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Invitation link'));
    await user.type(screen.getByLabelText('Invitation link'), `https://app.example/invite#token=${TOKEN}`);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Invited by Bob Admin')).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenCalledWith(TOKEN);
  });
});

describe('lazy-loaded routes', () => {
  it('the invitation token survives the lazy /invite chunk load and sign-in continuation', async () => {
    authApi.me.mockRejectedValueOnce(unauthorized());
    authApi.login.mockResolvedValue({ user: USER });
    mockSignedIn();
    invitationApi.preview.mockResolvedValue(PREVIEW);
    openInviteLink();
    expect(window.location.hash).toBe('');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Sign in' }));
    await signInAs(user, USER);
    expect(await screen.findByText('Invited by Bob Admin')).toBeInTheDocument();
    expect(invitationApi.preview).toHaveBeenCalledWith(TOKEN);
  });

  it('protected routes still redirect signed-out users before any lazy page loads', async () => {
    authApi.me.mockRejectedValue(unauthorized());
    renderApp('/settings/members');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(invitationApi.list).not.toHaveBeenCalled();
  });

  it('the lazy Members page loads for admins', async () => {
    mockSignedIn({ role: 'admin' });
    renderApp('/settings/members');
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
    // "Invite member" opens the invitation dialog on the (lazy) Invitations page
    expect(screen.getByRole('link', { name: 'Invite member' })).toHaveAttribute('href', '/settings/invitations');
  });

  it('the lazy Invitations page loads for admins', async () => {
    mockSignedIn({ role: 'admin' });
    renderApp('/settings/invitations');
    expect(await screen.findByRole('heading', { name: 'Invitations' })).toBeInTheDocument();
  });
});
