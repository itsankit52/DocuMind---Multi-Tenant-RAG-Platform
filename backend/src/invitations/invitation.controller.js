/**
 * Invitee-facing invitation routes (Phase 3), mounted at /api/invitations behind
 * authMiddleware. Organization, role and email are never taken from the client: the
 * invitation token is the only input, and everything else is derived from the stored row.
 */

const express = require('express');
const zod = require('zod');
const rateLimiter = require('../middleware/rate-limiter');
const invitationService = require('./invitation.service');
const AppError = require('../utils/AppError');

const router = express.Router();

// Per authenticated user. Keys never contain the token. Tokens carry 256 bits of entropy,
// so these bound load and abuse rather than guessing. Fail-closed (Phase 3.2E / F6): if
// Redis is unavailable these two endpoints answer 503 instead of becoming unlimited.
const previewRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `ratelimit:invite-preview:${req.user.id}`,
  failClosed: true,
});
const acceptRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `ratelimit:invite-accept:${req.user.id}`,
  failClosed: true,
});

// Exactly the shape generated in Phase 2: 32 random bytes, base64url, unpadded.
const tokenSchema = zod.string('Invitation token is required')
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Invitation token is malformed');

// Strict: organization, role, email or status in the body are rejected, never interpreted.
// Preview and accept share it: the token travels ONLY in the JSON body, never in a URL
// (URLs reach proxy/error logs and history). The former GET /preview?token=… was removed.
const tokenBodySchema = zod.object({ token: tokenSchema }).strict();

/** Token-bearing requests/responses are never cached or forwarded as a Referer. */
const sensitive = (res) => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });

router.post('/preview', previewRateLimiter, async (req, res, next) => {
  sensitive(res);
  try {
    // A query string here is a client sending the token in the URL: refuse (never echoed).
    if (Object.keys(req.query || {}).length > 0) {
      return next(new AppError('Query parameters are not accepted. Send the invitation token in the request body.', 400));
    }
    const parsed = tokenBodySchema.safeParse(req.body === undefined ? {} : req.body);
    if (!parsed.success) return next(AppError.fromZod(parsed.error));
    const result = await invitationService.previewInvitation({ token: parsed.data.token, userId: req.user.id });
    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(AppError.from(err));
  }
});

router.post('/accept', acceptRateLimiter, async (req, res, next) => {
  sensitive(res);
  try {
    const parsed = tokenBodySchema.safeParse(req.body === undefined ? {} : req.body);
    if (!parsed.success) return next(AppError.fromZod(parsed.error));
    const result = await invitationService.acceptInvitation({ token: parsed.data.token, userId: req.user.id });
    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(AppError.from(err));
  }
});

module.exports = router;
