/**
 * Google OAuth 2.0 / OpenID Connect — protocol layer (authorization-code flow with PKCE).
 *
 * Uses Google's official google-auth-library:
 *  - authorization URL: scopes openid email profile, state, nonce, S256 PKCE challenge
 *  - code exchange: server-to-server with the client secret and the PKCE verifier
 *  - ID token verification (verifyIdToken): RS256 signature against Google's published keys,
 *    issuer (accounts.google.com), audience = GOOGLE_CLIENT_ID, expiry
 *  - then, here: nonce match, `sub` present, email present and email_verified === true
 *
 * Only the verified ID-token claims are used. Google's access/ID tokens are discarded after
 * verification: never stored, logged or returned. Nothing from the browser is trusted as
 * identity. Every failure is a GoogleAuthError with a short code (never token contents).
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');

const SCOPES = ['openid', 'email', 'profile'];

class GoogleAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

let client = null;
/** Lazily created; tests may replace it with setClientForTests(). */
function getClient() {
  if (!client) {
    client = new OAuth2Client({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_CALLBACK_URL,
    });
  }
  return client;
}
function setClientForTests(c) { client = c; }

const base64url = (buf) => buf.toString('base64url');
const randomToken = (bytes = 32) => base64url(crypto.randomBytes(bytes));
/** PKCE (RFC 7636): 43-char verifier from 32 random bytes, S256 challenge. */
function createPkcePair() {
  const verifier = randomToken(32);
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizationUrl({ state, nonce, codeChallenge }) {
  return getClient().generateAuthUrl({
    access_type: 'online', // no Google refresh token: DocuMind keeps its own session
    scope: SCOPES,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    include_granted_scopes: false,
  });
}

/**
 * Exchange the authorization code and verify the resulting ID token.
 * @returns {Promise<{ sub: string, email: string, emailVerified: true, name: string|null, picture: string|null }>}
 */
async function exchangeCodeForIdentity({ code, codeVerifier, nonce }) {
  let idToken;
  try {
    const { tokens } = await getClient().getToken({ code, codeVerifier, redirect_uri: env.GOOGLE_CALLBACK_URL });
    idToken = tokens && tokens.id_token;
  } catch {
    // Invalid/expired/reused code, PKCE mismatch, or Google unreachable (details not logged)
    throw new GoogleAuthError('code_exchange_failed');
  }
  if (!idToken) throw new GoogleAuthError('code_exchange_failed');
  return verifyIdToken(idToken, { nonce });
}

/** Verify a Google ID token and return the normalized identity (see module comment). */
async function verifyIdToken(idToken, { nonce }) {
  let payload;
  try {
    const ticket = await getClient().verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new GoogleAuthError('id_token_invalid'); // signature, issuer, audience or expiry
  }
  if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) {
    throw new GoogleAuthError('id_token_invalid');
  }
  if (typeof nonce !== 'string' || payload.nonce !== nonce) throw new GoogleAuthError('id_token_invalid');
  if (typeof payload.email !== 'string' || payload.email.length === 0 || payload.email.length > 254) {
    throw new GoogleAuthError('email_missing');
  }
  if (payload.email_verified !== true) throw new GoogleAuthError('email_unverified');

  return {
    sub: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: true,
    name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : null,
    picture: safePictureUrl(payload.picture),
  };
}

/** Only an https URL of bounded length is stored as an avatar. */
function safePictureUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

module.exports = {
  GoogleAuthError,
  SCOPES,
  buildAuthorizationUrl,
  createPkcePair,
  exchangeCodeForIdentity,
  getClient,
  randomToken,
  setClientForTests,
  verifyIdToken,
};
