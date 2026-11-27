import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ApiError } from '../api/client';
import { AuthProvider } from '../context/AuthContext';
import { AppRoutes } from '../App';
import { authApi } from './apiMock';
import { mockSignedIn, renderApp, resetApiMocks, unauthorized, USER } from './utils';

vi.mock('../api/endpoints', () => import('./apiMock'));

let assign;
beforeEach(() => {
  resetApiMocks();
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

const signedOut = () => authApi.me.mockRejectedValue(unauthorized());

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function renderWithLocation(route) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider><AppRoutes /><LocationProbe /></AuthProvider>
    </MemoryRouter>,
  );
}

describe('Continue with Google button', () => {
  it.each([['/login', 'Sign in'], ['/register', 'Create your account']])('is shown on %s with the Google logo and an "or" divider', async (route, title) => {
    signedOut();
    renderApp(route);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    expect(button.querySelector('svg.google-logo')).not.toBeNull();
    expect(button.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // no emoji
    expect(screen.getByRole('separator')).toHaveTextContent('or');
  });

  it('navigates the whole page to the backend start URL, once, without any token', async () => {
    signedOut();
    renderApp('/login');
    const button = await screen.findByRole('button', { name: 'Continue with Google' });
    await userEvent.setup().click(button);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/api/auth/google');
    expect(screen.getByRole('button', { name: 'Redirecting to Google…' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Redirecting to Google…' }));
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('warns that an invitation link must be reopened after Google sign-in', async () => {
    signedOut();
    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: '/invite' } }]}>
        <AuthProvider><AppRoutes /></AuthProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/open your invitation link again after signing in/)).toBeInTheDocument();
  });
});

describe('Google completion page', () => {
  it('loads the session from the cookie and goes to the app; the result code leaves the URL', async () => {
    mockSignedIn();
    renderWithLocation('/auth/google/complete?status=signed_in');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/));
    expect(authApi.me).toHaveBeenCalled();
  });

  it('a new Google user without an organization goes to onboarding (no automatic join)', async () => {
    authApi.me.mockResolvedValue({ user: USER, organizations: [] });
    renderWithLocation('/auth/google/complete?status=signed_up');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/onboarding'));
  });

  it.each([
    ['cancelled', 'Google sign-in was cancelled.'],
    ['account_exists', /An account with this email address already exists/],
    ['account_conflict', /can’t be used to sign in to DocuMind/],
    ['email_unverified', /email address isn’t verified/],
    ['not_configured', /isn’t set up on this DocuMind server/],
    ['<script>alert(1)</script>', 'Google sign-in failed. Please try again.'],
  ])('error "%s" shows a fixed message and a way back', async (code, message) => {
    signedOut();
    renderWithLocation(`/auth/google/complete?error=${encodeURIComponent(code)}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/auth\/google\/complete$/);
  });

  it('reports a failure when no session was created', async () => {
    signedOut();
    renderWithLocation('/auth/google/complete?status=signed_in');
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in failed. Please try again.');
  });
});

describe('Account page: explicit Google linking', () => {
  const withMethods = (methods, extra = {}) => authApi.me.mockResolvedValue({
    user: { ...USER, authMethods: methods }, organizations: [], googleSignInEnabled: true, ...extra,
  });

  it('requires the current password, then sends the browser to Google', async () => {
    withMethods({ password: true, google: false });
    authApi.linkGoogle.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' });
    renderApp('/settings/account');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Link Google account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your current password.');
    expect(authApi.linkGoogle).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Current password'), 'Password123!');
    await user.click(screen.getByRole('button', { name: 'Link Google account' }));
    expect(authApi.linkGoogle).toHaveBeenCalledWith('Password123!');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s'));
  });

  it('shows a wrong password without leaving the page', async () => {
    withMethods({ password: true, google: false });
    authApi.linkGoogle.mockRejectedValue(new ApiError(401, 'Incorrect password.'));
    renderApp('/settings/account');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Current password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Link Google account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect password.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows linked accounts and offers no link form', async () => {
    withMethods({ password: true, google: true });
    renderApp('/settings/account');
    expect(await screen.findByText('Linked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link Google account' })).not.toBeInTheDocument();
  });

  it('offers no link form when Google sign-in is not configured', async () => {
    withMethods({ password: true, google: false }, { googleSignInEnabled: false });
    renderApp('/settings/account');
    expect(await screen.findByText('Google sign-in isn’t set up on this server.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link Google account' })).not.toBeInTheDocument();
  });

  it('a successful link returns to the account page with a notice', async () => {
    withMethods({ password: true, google: true });
    renderWithLocation('/auth/google/complete?status=linked');
    expect(await screen.findByText('Your Google account is now linked.')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/account');
  });
});
