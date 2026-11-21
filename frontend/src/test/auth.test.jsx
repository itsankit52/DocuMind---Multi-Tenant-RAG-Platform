import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, getActiveOrganizationId, toApiError } from '../api/client';
import { authApi, organizationApi } from './apiMock';
import { deferred, mockSignedIn, ORG_A, renderApp, resetApiMocks, unauthorized, USER } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

beforeEach(() => resetApiMocks());

describe('Authentication', () => {
  it('does not render protected pages until the session is resolved', async () => {
    const pending = deferred();
    authApi.me.mockReturnValue(pending.promise);
    renderApp('/documents');
    expect(screen.getByText('Loading DocuMind…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Documents' })).not.toBeInTheDocument();
    pending.reject(unauthorized());
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('redirects unauthenticated users from protected routes to login', async () => {
    authApi.me.mockRejectedValue(unauthorized());
    renderApp('/chat');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('login success restores the user and opens the dashboard with the org header set', async () => {
    authApi.me.mockRejectedValueOnce(unauthorized());
    authApi.login.mockResolvedValue({ user: USER });
    mockSignedIn(); // initial /me (queued rejection above) fails; post-login /me succeeds

    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(authApi.login).toHaveBeenCalledWith({ email: 'alice@example.com', password: 'Password123!' });
    expect(getActiveOrganizationId()).toBe(ORG_A.organization_id);
    // No token handling in JS: nothing auth-related is persisted to storage
    expect(Object.keys(window.localStorage).some(k => /token|jwt/i.test(k))).toBe(false);
  });

  it('login failure shows a safe message and stays on the login page', async () => {
    authApi.me.mockRejectedValue(unauthorized());
    authApi.login.mockRejectedValue(new ApiError(401, 'Invalid email or password'));
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('prevents duplicate login submissions while a request is in flight', async () => {
    authApi.me.mockRejectedValue(unauthorized());
    const pending = deferred();
    authApi.login.mockReturnValue(pending.promise);
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(authApi.login).toHaveBeenCalledTimes(1);
    pending.reject(unauthorized());
  });

  it('register creates the account, signs in and sends a user without an organization to onboarding', async () => {
    authApi.me.mockRejectedValueOnce(unauthorized());
    authApi.register.mockResolvedValue({ user: USER });
    authApi.login.mockResolvedValue({ user: USER });
    authApi.me.mockResolvedValue({ user: USER, organizations: [] });
    renderApp('/register');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123!');
    await user.type(screen.getByLabelText('Confirm password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Create your organization' })).toBeInTheDocument();
    expect(authApi.register).toHaveBeenCalledWith({ email: 'alice@example.com', password: 'Password123!', fullName: undefined });
  });

  it('register validates input before calling the API', async () => {
    authApi.me.mockRejectedValue(unauthorized());
    renderApp('/register');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'alice@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 8 characters');
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('onboarding creates an organization and enters the app', async () => {
    authApi.me.mockResolvedValueOnce({ user: USER, organizations: [] });
    organizationApi.create.mockResolvedValue({ org: { id: 'org-a' } });
    mockSignedIn();
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Organization name'), 'Acme Corp');
    expect(screen.getByLabelText('URL name')).toHaveValue('acme-corp');
    await user.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(organizationApi.create).toHaveBeenCalledWith({ name: 'Acme Corp', slug: 'acme-corp' });
  });

  it('logout clears the session and returns to login', async () => {
    mockSignedIn();
    authApi.logout.mockResolvedValue({});
    renderApp('/');
    await waitFor(() => expect(window.localStorage.getItem('documind.activeOrganization')).toBe(ORG_A.organization_id));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(authApi.logout).toHaveBeenCalled();
    expect(getActiveOrganizationId()).toBeNull();
    // An explicit sign-out also forgets the preferred organization on this browser
    expect(window.localStorage.getItem('documind.activeOrganization')).toBeNull();
    expect(screen.queryByText('Your session has expired. Please sign in again.')).not.toBeInTheDocument();
  });

  it('switching organization is confirmed by the backend before it takes effect', async () => {
    mockSignedIn({ organizations: [ORG_A, { organization_id: 'org-b', name: 'Beta', slug: 'beta', role: 'viewer' }] });
    organizationApi.select.mockRejectedValueOnce(toApiError(403, 'raw server text'));
    renderApp('/');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Organization'), 'org-b');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('permission');
    expect(alert).not.toHaveTextContent('raw server text');
    expect(getActiveOrganizationId()).toBe('org-a');

    await user.selectOptions(screen.getByLabelText('Organization'), 'org-b');
    await waitFor(() => expect(getActiveOrganizationId()).toBe('org-b'));
    expect(organizationApi.select).toHaveBeenLastCalledWith('org-b');
  });
});
