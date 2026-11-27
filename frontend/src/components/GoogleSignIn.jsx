/**
 * "Continue with Google" (Google sign-in branding: standard multicolor "G" mark, neutral
 * button, "Continue with Google" label). Clicking does a full-page navigation to the backend,
 * which redirects to Google; the backend callback later returns to /auth/google/complete.
 * No token, code or identity ever passes through this component.
 */

import { useState } from 'react';
import { authApi } from '../api/endpoints';

export function GoogleLogo() {
  return (
    <svg className="google-logo" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function GoogleSignInButton({ disabled = false }) {
  const [redirecting, setRedirecting] = useState(false);
  const onClick = () => {
    if (redirecting || disabled) return; // no repeated submissions while leaving the page
    setRedirecting(true);
    window.location.assign(authApi.googleSignInUrl());
  };
  return (
    <button type="button" className="btn btn-google btn-block" onClick={onClick}
      disabled={disabled || redirecting} aria-busy={redirecting || undefined}>
      <GoogleLogo />
      <span>{redirecting ? 'Redirecting to Google…' : 'Continue with Google'}</span>
    </button>
  );
}

export function AuthDivider() {
  return <div className="auth-divider" role="separator"><span>or</span></div>;
}

/** Fixed, user-facing messages for the backend's short result codes (never server text). */
const ERROR_MESSAGES = {
  cancelled: 'Google sign-in was cancelled.',
  account_exists: 'An account with this email address already exists. Sign in with your email and password, then link Google from your account settings.',
  account_conflict: 'This Google account can’t be used to sign in to DocuMind. Sign in with your email and password, or contact your administrator.',
  account_disabled: 'This account is disabled. Contact your administrator.',
  email_unverified: 'Your Google account’s email address isn’t verified. Verify it with Google and try again.',
  email_missing: 'Google didn’t share an email address for this account.',
  not_configured: 'Google sign-in isn’t set up on this DocuMind server yet. Use your email and password.',
  expired_state: 'The Google sign-in took too long or was already used. Please try again.',
  invalid_state: 'The Google sign-in couldn’t be verified for this browser. Please start again from this page.',
  email_mismatch: 'The Google account must use the same email address as your DocuMind account.',
  google_account_in_use: 'That Google account is already linked to another DocuMind account.',
  already_linked: 'A Google account is already linked to your DocuMind account.',
};
export const GENERIC_GOOGLE_ERROR = 'Google sign-in failed. Please try again.';
export const googleErrorMessage = (code) => ERROR_MESSAGES[code] || GENERIC_GOOGLE_ERROR;
