/**
 * RAG API Controller
 * Exposes endpoints for executing tenant-safe RAG question-answering queries.
 */

const express = require('express');
const router = express.Router();
const ragService = require('./rag.service');
const { checkRole } = require('../middleware/rbac');
const AppError = require('../utils/AppError');

/**
 * POST /api/rag/query
 * Execute a RAG question against the organization's indexed documents.
 * Requires: Authentication + Active Tenant Context + Role (admin/member/viewer).
 */
router.post(
  '/query',
  checkRole(['admin', 'member', 'viewer']),
  async (req, res, next) => {
    try {
      const { question, topK, scoreThreshold } = req.body;

      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        throw new AppError('Question is required and must be a non-empty string.', 400);
      }

      // Organization ID strictly derived from authoritative tenant middleware, never from body
      const orgId = res.locals.tenantId || req.tenantId;
      const userId = req.user.id;

      const result = await ragService.answerQuestion({
        organizationId: orgId,
        userId,
        question: question.trim(),
        topK: topK ? Number(topK) : undefined,
        scoreThreshold: scoreThreshold !== undefined ? Number(scoreThreshold) : undefined,
      });

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
