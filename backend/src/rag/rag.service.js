/**
 * RAG Query Orchestrator Service
 * Coordinates the complete RAG Question-Answering pipeline:
 * Question -> Embedding -> Qdrant Tenant Search -> PostgreSQL RLS Cross-Verification ->
 * Context Construction -> (optional) Conversation History -> Grounded LLM Generation -> Citations.
 *
 * Step 9 addition: accepts optional `conversationContext` string that is prepended
 * to the document context block in the LLM prompt.  When absent the service behaves
 * exactly as it did in Step 8 — all existing tests remain unaffected.
 */

const env = require('../config/env');
const retrievalService = require('./retrieval.service');
const contextService = require('./context.service');
const ollamaService = require('../llm/ollama.service');
const auditRepo = require('../repositories/audit.repository');
const AppError = require('../utils/AppError');

const NO_CONTEXT_ANSWER = "I couldn't find relevant information in your organization's documents.";

class RagService {
  /**
   * Shared grounding stage used by both the complete (Step 8/9) and streaming (Step 10) paths:
   * validation -> tenant-filtered retrieval (embedding, Qdrant organization_id filter,
   * PostgreSQL RLS cross-check) -> injection-safe context construction -> optional history.
   *
   * @param {object} params - { organizationId, question, topK, scoreThreshold, conversationContext }
   * @returns {Promise<object>} - { trimmedQuestion, effectiveTopK, hasContext, fullContextText, sources }
   */
  async prepareGroundedContext({
    organizationId,
    question,
    topK,
    scoreThreshold,
    conversationContext,
  }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new AppError('Question is required.', 400);
    }

    const trimmedQuestion = question.trim();
    const effectiveTopK = topK || env.RAG_TOP_K || 5;

    // Step 1: Retrieve tenant-isolated document chunks with two-stage verification
    const retrievedChunks = await retrievalService.retrieveContext({
      organizationId,
      question: trimmedQuestion,
      topK: effectiveTopK,
      scoreThreshold,
    });

    // Step 2: No relevant documents/chunks exist
    if (!retrievedChunks || retrievedChunks.length === 0) {
      return { trimmedQuestion, effectiveTopK, hasContext: false, fullContextText: '', sources: [] };
    }

    // Step 3: Build structured, prompt-injection-safe document context
    const { contextText, sources } = contextService.buildContext(retrievedChunks);

    // Step 4: Compose the full context sent to the LLM.
    // When conversationContext is present it is prepended to the document context
    // so the LLM can resolve pronouns / follow-up references.
    // The two blocks are kept visually distinct so the model understands the
    // conversation history is reference data, not instructions.
    const fullContextText = conversationContext && conversationContext.trim().length > 0
      ? `${conversationContext}

${contextText}`
      : contextText;

    return { trimmedQuestion, effectiveTopK, hasContext: true, fullContextText, sources };
  }

  /**
   * Answers a user question grounded in the organization's documents.
   *
   * @param {object} params
   * @param {string}      params.organizationId
   * @param {string}      [params.userId]
   * @param {string}      params.question
   * @param {number}      [params.topK]
   * @param {number}      [params.scoreThreshold]
   * @param {string}      [params.conversationContext]  - Optional prior-turn history string
   *                       produced by ChatService._buildConversationContext().
   *                       Injected into the LLM prompt BEFORE the document context block
   *                       so the model can resolve follow-up references ("it", "them", etc.).
   *                       The string is already labelled and delimited by the caller to
   *                       prevent it from being interpreted as system instructions.
   * @returns {Promise<object>} - { answer, sources, retrieval }
   */
  async answerQuestion({
    organizationId,
    userId,
    question,
    topK,
    scoreThreshold,
    conversationContext,
  }) {
    const {
      trimmedQuestion,
      effectiveTopK,
      hasContext,
      fullContextText,
      sources,
    } = await this.prepareGroundedContext({
      organizationId,
      question,
      topK,
      scoreThreshold,
      conversationContext,
    });

    // Handle case where no relevant documents/chunks exist
    if (!hasContext) {
      try {
        await auditRepo.log({
          organizationId,
          actorId: userId || null,
          action: 'RAG_QUERY',
          resourceId: null,
          metadata: {
            questionLength: trimmedQuestion.length,
            chunksRetrieved: 0,
            hasAnswer: false,
            hasConversationContext: !!(conversationContext && conversationContext.length > 0),
          },
        });
      } catch (logErr) {
        console.warn('Audit logging warning:', logErr.message);
      }

      return {
        answer: NO_CONTEXT_ANSWER,
        sources: [],
        retrieval: {
          topK: effectiveTopK,
          returnedChunks: 0,
        },
      };
    }

    // Step 5: Generate grounded answer via Ollama LLM
    let answer;
    try {
      answer = await ollamaService.generateAnswer({
        userQuestion: trimmedQuestion,
        contextText: fullContextText,
      });
    } catch (llmErr) {
      throw new AppError(`LLM generation service error: ${llmErr.message}`, 503);
    }

    // Step 6: Audit log
    try {
      await auditRepo.log({
        organizationId,
        actorId: userId || null,
        action: 'RAG_QUERY',
        resourceId: null,
        metadata: {
          questionLength: trimmedQuestion.length,
          chunksRetrieved: sources.length,
          hasAnswer: true,
          hasConversationContext: !!(conversationContext && conversationContext.length > 0),
        },
      });
    } catch (logErr) {
      console.warn('Audit logging warning:', logErr.message);
    }

    // Step 7: Return clean response with structured citations
    return {
      answer,
      sources: sources.map(s => ({
        documentId: s.documentId,
        chunkId: s.chunkId,
        documentName: s.documentName,
        chunkIndex: s.chunkIndex,
        pageStart: s.pageStart,
        pageEnd: s.pageEnd,
        score: s.score,
      })),
      retrieval: {
        topK: effectiveTopK,
        returnedChunks: sources.length,
      },
    };
  }
}

module.exports = require('../observability/instrument').instrumentRag(new RagService());
module.exports.NO_CONTEXT_ANSWER = NO_CONTEXT_ANSWER;
