/**
 * Conversation Controller
 * REST API for conversation management and multi-turn chat.
 *
 * All routes require:
 *   - authMiddleware    → populates req.user
 *   - tenantMiddleware  → populates res.locals.tenantId, res.locals.userRole
 *
 * organization_id is ALWAYS derived from res.locals.tenantId.
 * Any organizationId in req.body / req.query / req.params is ignored as authority.
 *
 * Endpoints:
 *   POST   /api/conversations                         Create conversation
 *   GET    /api/conversations                         List conversations
 *   GET    /api/conversations/:conversationId         Get conversation + messages
 *   PATCH  /api/conversations/:conversationId         Rename conversation
 *   DELETE /api/conversations/:conversationId         Soft-delete conversation
 *   GET    /api/conversations/:conversationId/messages  List messages
 *   POST   /api/conversations/:conversationId/messages  Send message (chat)
 *   POST   /api/conversations/:conversationId/messages/stream  Send message (SSE streaming)
 */

const express = require('express');
const router = express.Router();
const conversationService = require('./conversation.service');
const chatService = require('./chat.service');
const { checkRole } = require('../middleware/rbac');
const rateLimiter = require('../middleware/rate-limiter');
const chatStreamService = require('./chat-stream.service');
const { STREAM_ERRORS } = require('./chat-stream.service');
const { SseSession, streamRegistry } = require('../sse/sse-session');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../observability/logger');

// ─── Chat-specific rate limiter ───────────────────────────────────────────────
// LLM generation is expensive — apply a tighter limit than general API traffic.
// req.tenantId and req.user are both guaranteed to be set here: tenantMiddleware
// runs before this router is reached (see app.js mount), so we can reference them directly.
const chatRateLimiter = rateLimiter({
  windowMs: parseInt(env.CHAT_RATE_WINDOW || '60000', 10),
  max: parseInt(env.CHAT_RATE_LIMIT || '20', 10),
  keyGenerator: (req) =>
    `ratelimit:chat:${req.tenantId || req.ip}:${req.user ? req.user.id : req.ip}`,
});

// ─── Helper: extract tenant id ────────────────────────────────────────────────
function getOrgId(req, res) {
  return res.locals.tenantId || req.tenantId;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversations
// Create a new conversation for the authenticated user in the current tenant.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  checkRole(['admin', 'member', 'viewer']),
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const userId = req.user.id;
      const { title } = req.body;

      const conversation = await conversationService.createConversation({
        organizationId: orgId,
        userId,
        title,
      });

      res.status(201).json({
        status: 'success',
        data: { conversation },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/conversations
// List all non-deleted conversations for the current tenant.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  checkRole(['admin', 'member', 'viewer']),
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const { page, limit } = req.query;

      const result = await conversationService.listConversations({
        organizationId: orgId,
        page,
        limit,
      });

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/conversations/:conversationId
// Get a conversation with its full message history.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:conversationId',
  checkRole(['admin', 'member', 'viewer']),
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const { conversationId } = req.params;

      const result = await conversationService.getConversationWithMessages({
        organizationId: orgId,
        conversationId,
      });

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/conversations/:conversationId
// Rename a conversation. Only title may be changed.
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:conversationId',
  checkRole(['admin', 'member']),
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const { conversationId } = req.params;
      const { title } = req.body;

      const conversation = await conversationService.updateConversation({
        organizationId: orgId,
        conversationId,
        title,
        userId: req.user.id,
        role: res.locals.userRole,
      });

      res.status(200).json({
        status: 'success',
        data: { conversation },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/conversations/:conversationId
// Soft-delete a conversation. Admin & Member only.
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/:conversationId',
  checkRole(['admin', 'member']),
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const userId = req.user.id;
      const { conversationId } = req.params;

      await conversationService.deleteConversation({
        organizationId: orgId,
        userId,
        conversationId,
        role: res.locals.userRole,
      });

      res.status(200).json({
        status: 'success',
        message: 'Conversation deleted successfully.',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/conversations/:conversationId/messages
// List messages for a conversation.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:conversationId/messages',
  checkRole(['admin', 'member', 'viewer']),
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const { conversationId } = req.params;

      const messages = await conversationService.getMessages({
        organizationId: orgId,
        conversationId,
      });

      res.status(200).json({
        status: 'success',
        data: { messages },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversations/:conversationId/messages
// Send a user message → execute RAG pipeline → persist and return assistant reply.
//
// Optional header: Idempotency-Key: <client-generated key>
// Sending the same Idempotency-Key twice returns the original response without
// re-running the LLM.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:conversationId/messages',
  checkRole(['admin', 'member', 'viewer']),
  chatRateLimiter,
  async (req, res, next) => {
    try {
      const orgId = getOrgId(req, res);
      const userId = req.user.id;
      const { conversationId } = req.params;
      const { content } = req.body;

      // Read idempotency key from the standard header (never from body to avoid spoofing)
      const idempotencyKey = req.headers['idempotency-key'] || null;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return next(new AppError('Message content is required.', 400));
      }

      const result = await chatService.sendMessage({
        organizationId: orgId,
        userId,
        conversationId,
        content: content.trim(),
        idempotencyKey,
      });

      // 200 for idempotent replays, 201 for new messages
      const statusCode = result.idempotent ? 200 : 201;

      res.status(statusCode).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversations/:conversationId/messages/stream
// Send a user message → stream the RAG-grounded answer via Server-Sent Events.
// Same auth, tenant, RBAC, rate limit and Idempotency-Key contract as the
// non-streaming endpoint. Full protocol: API.md → "Streaming Chat (SSE)".
//
//   event: start     data: { conversationId, userMessageId }
//   event: token     data: { text }
//   event: citation  data: { id, documentId, chunkId, documentName, chunkIndex, page, relevanceScore }
//   event: done      data: { conversationId, messageId, finishReason }
//   event: error     data: { code, message }
//
// Errors before the stream starts (400/401/403/404/409/429/503) are normal JSON
// responses; after it starts they are a single `error` event.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:conversationId/messages/stream',
  checkRole(['admin', 'member', 'viewer']),
  chatRateLimiter,
  async (req, res, next) => {
    if (streamRegistry.isShuttingDown()) {
      return next(new AppError('Server is shutting down. Please retry shortly.', 503));
    }

    // ── Pre-stream checks: failures here are ordinary HTTP errors ──────────
    let prepared;
    try {
      prepared = await chatStreamService.prepareStream({
        organizationId: getOrgId(req, res),
        userId: req.user.id,
        conversationId: req.params.conversationId,
        content: req.body && req.body.content,
        idempotencyKey: req.headers['idempotency-key'] || null,
      });
    } catch (err) {
      return next(err);
    }

    // ── Stream: from here on only SSE events may be written ────────────────
    const session = new SseSession(req, res, {
      heartbeatIntervalMs: env.SSE_HEARTBEAT_INTERVAL_MS || 15000,
      timeoutMs: env.CHAT_STREAM_TIMEOUT_MS || 120000,
    });
    session.start();

    try {
      await chatStreamService.runStream(prepared, { signal: session.signal, emit: session.emit });
    } catch (err) {
      logger.error('ChatStream unexpected failure', { error: err });
      session.emit('error', { code: 'INTERNAL_ERROR', message: STREAM_ERRORS.INTERNAL_ERROR });
    } finally {
      session.end();
    }
  },
);

module.exports = router;
