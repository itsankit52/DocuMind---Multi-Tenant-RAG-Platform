/**
 * The application session: HttpOnly accessToken / refreshToken cookies (SameSite=Strict,
 * Secure in production). Shared by password login and Google sign-in so both produce the
 * exact same session; the tokens come from authService.generateTokens().
 */

const env = require('../config/env');

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function setSessionCookies(res, tokens) {
  const base = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'Strict' };
  res.cookie('accessToken', tokens.accessToken, { ...base, maxAge: ACCESS_MAX_AGE_MS });
  res.cookie('refreshToken', tokens.refreshToken, { ...base, maxAge: REFRESH_MAX_AGE_MS });
}

module.exports = { setSessionCookies };
