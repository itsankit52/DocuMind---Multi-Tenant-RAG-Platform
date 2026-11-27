/**
 * Google sign-in routes (mounted at /api/auth/google).
 *
 *   GET  /api/auth/google           start sign-in / sign-up → 302 to Google
 *   POST /api/auth/google/link      authenticated + password re-check → { url } to start linking
 *   GET  /api/auth/google/callback  Google redirect target (GOOGLE_CALLBACK_URL)
 *
 * The callback always ends with a 302 to the frontend completion page,
 *   ${APP_BASE_URL}/auth/google/complete?status=<code>   or   ?error=<code>
 * carrying only a short fixed code — never a token, Google code, state or email. On sign-in it
 * sets the same HttpOnly session cookies as password login. The redirect target is built only
 * from APP_BASE_URL (validated config), never from request input, so it cannot be redirected
 * to another site.
 *
 * Browser binding: initiation sets an HttpOnly, SameSite=Lax cookie (Lax so it is sent on
 * Google's top-level redirect back), path-scoped to /api/auth/google, holding a random value
 * whose hash is stored with the one-time state (see oauth-state.js).
 */

const express = require('express');
const zod = require('zod');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const authMiddleware = require('../middleware/auth');
const rateLimiter = require('../middleware/rate-limiter');
const authService = require('./auth.service');
const google = require('./google.oauth');
const oauthState = require('./oauth-state');
const googleService = require('./google.service');
const oauthRepo = require('../repositories/oauth.repository');
const { setSessionCookies } = require('./session-cookies');
const logger = require('../observability/logger');

const router = express.Router();

const BINDING_COOKIE = 'documind_oauth_binding';
const BINDING_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'Lax',
  path: '/api/auth/google',
};

const googleRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `ratelimit:auth-google:${req.ip}`,
});

const linkSchema = zod.object({
  password: zod.string().min(1, 'Password is required').max(128, 'Invalid credentials'),
}).strict();

const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });

function completionUrl(params) {
  return `${env.APP_BASE_URL}/auth/google/complete?${new URLSearchParams(params).toString()}`;
}

function notConfigured(res, next) {
  if (env.APP_BASE_URL) return res.redirect(302, completionUrl({ error: 'not_configured' }));
  return next(new AppError('Google sign-in is not configured.', 503));
}

/** Create the one-time state + PKCE + nonce, set the binding cookie, return Google's URL. */
async function startFlow(res, { intent, userId = null }) {
  const state = google.randomToken(32);
  const binding = google.randomToken(32);
  const nonce = google.randomToken(16);
  const { verifier, challenge } = google.createPkcePair();
  await oauthState.saveState({ state, binding, codeVerifier: verifier, nonce, intent, userId });
  res.cookie(BINDING_COOKIE, binding, { ...BINDING_COOKIE_OPTIONS, maxAge: oauthState.STATE_TTL_SECONDS * 1000 });
  return google.buildAuthorizationUrl({ state, nonce, codeChallenge: challenge });
}

// Sign in / sign up
router.get('/', googleRateLimiter, async (req, res, next) => {
  noStore(res);
  if (!env.GOOGLE_OAUTH_ENABLED) return notConfigured(res, next);
  try {
    res.redirect(302, await startFlow(res, { intent: 'login' }));
  } catch (err) {
    logger.error('Google sign-in could not start', { error: { type: err && err.name } });
    res.redirect(302, completionUrl({ error: 'unavailable' }));
  }
});

// Link Google to the signed-in account; the password is re-checked first.
router.post('/link', googleRateLimiter, authMiddleware, async (req, res, next) => {
  noStore(res);
  if (!env.GOOGLE_OAUTH_ENABLED) return next(new AppError('Google sign-in is not configured.', 503));
  try {
    const parsed = linkSchema.safeParse(req.body || {});
    if (!parsed.success) return next(AppError.fromZod(parsed.error));
    const methods = await oauthRepo.getAuthMethods(req.user.id);
    if (methods.google) return next(new AppError('A Google account is already linked.', 409));
    await authService.verifyCurrentPassword(req.user.id, parsed.data.password);
    const url = await startFlow(res, { intent: 'link', userId: req.user.id });
    res.status(200).json({ status: 'success', data: { url } });
  } catch (err) {
    next(AppError.from(err));
  }
});

router.get('/callback', googleRateLimiter, async (req, res, next) => {
  noStore(res);
  res.clearCookie(BINDING_COOKIE, BINDING_COOKIE_OPTIONS);
  if (!env.GOOGLE_OAUTH_ENABLED) return notConfigured(res, next);
  const fail = (code) => res.redirect(302, completionUrl({ error: code }));

  const { state, code, error } = req.query;
  if (typeof state !== 'string' || state.length === 0 || state.length > 128) return fail('invalid_state');

  let record;
  try {
    record = await oauthState.consumeState(state); // one-time: deleted here whatever happens next
  } catch {
    return fail('unavailable');
  }
  if (!record) return fail('expired_state');
  if (!oauthState.matchesBinding(record, req.cookies && req.cookies[BINDING_COOKIE])) return fail('invalid_state');

  if (error !== undefined) return fail(error === 'access_denied' ? 'cancelled' : 'google_error');
  if (typeof code !== 'string' || code.length === 0 || code.length > 2048) return fail('invalid_request');

  try {
    const identity = await google.exchangeCodeForIdentity({ code, codeVerifier: record.codeVerifier, nonce: record.nonce });

    if (record.intent === 'link') {
      await googleService.linkGoogleAccount(record.userId, identity);
      return res.redirect(302, completionUrl({ status: 'linked' }));
    }

    const { user, created } = await googleService.signInWithGoogle(identity);
    setSessionCookies(res, authService.generateTokens(user));
    return res.redirect(302, completionUrl({ status: created ? 'signed_up' : 'signed_in' }));
  } catch (err) {
    if (err instanceof google.GoogleAuthError) return fail(err.code);
    logger.error('Google sign-in failed', { error: { type: err && err.name, code: err && typeof err.code === 'string' ? err.code : undefined } });
    return fail('server_error');
  }
});

module.exports = router;
module.exports.BINDING_COOKIE = BINDING_COOKIE;
