/**
 * Chat Stream Service (Step 10)
 * Streaming variant of ChatService.sendMessage. Transport-agnostic: it reports progress
 * through an `emit(event, data)` callback (see src/sse/sse-session.js) and is cancelled
 * through an AbortSignal.
 *
 * Two phases:
 *
 *   prepareStream()  — runs BEFORE any SSE bytes are sent, so failures are normal HTTP errors:
 *                      input validation → conversation lookup (RLS) → idempotency check
 *                      → load limited history → persist user message
 *
 *   runStream()      — runs AFTER SSE headers are committed; failures become `error` events:
 *                      start → Step 8 grounding (embedding, Qdrant org filter, PG RLS cross-check,
 *                      context) → Ollama streaming → token* → persist ONE assistant message
 *                      + citations (one transaction) → citation* → done
 *
 * Invariants:
 *   - organization_id comes only from tenant context.
 *   - `done` is emitted only after the assistant message AND citations are committed.
 *   - Cancelled, timed-out, oversized or failed generations persist no assistant message.
 *   - Error events carry fixed safe messages; internal details go to the audit log only.
 */

const env = require('../config/env');
const { withTenantTransaction } = require('../db/transaction');
const convRepo = require('../repositories/conversation.repository');
const messageRepo = require('../repositories/message.repository');
const citationRepo = require('../repositories/citation.repository');
const auditRepo = require('../repositories/audit.repository');
const ragService = require('../rag/rag.service');
const ollamaService = require('../llm/ollama.service');
const chatService = require('./chat.service');
const AppError = require('../utils/AppError');
const { ABORT_CODES, ABORT_MESSAGES } = require('../sse/sse-session');
const logger = require('../observability/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128; // messages.idempotency_key VARCHAR(128)
const EMPTY_ANSWER_FALLBACK =
  'The provided documents do not contain enough information to answer this question.';

// Fixed client-facing errors. Never include upstream/internal error text.
const STREAM_ERRORS = Object.freeze({
  RETRIEVAL_ERROR: 'Unable to search your documents right now. Please try again.',
  LLM_STREAM_ERROR: 'Unable to generate a response.',
  RESPONSE_TOO_LARGE: 'The response exceeded the maximum allowed length and was stopped.',
  PERSISTENCE_ERROR: 'The response could not be saved. Please try again.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
});

class StreamFailure extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

/** Reject as soon as the signal aborts, even if `promise` itself cannot be cancelled. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function toCitationDto(c) {
  return {
    id: c.id,
    documentId: c.document_id,
    chunkId: c.chunk_id,
    documentName: c.document_name,
    chunkIndex: c.chunk_index,
    page: c.page_number,
    relevanceScore: c.relevance_score,
  };
}

class ChatStreamService {
  /**
   * Pre-stream phase. Throws AppError (→ HTTP 4xx/5xx) — no SSE bytes have been sent yet.
   *
   * @returns {Promise<object>} prepared context; `replay` is set for an idempotent duplicate
   */
  async prepareStream({ organizationId, userId, conversationId, content, idempotencyKey }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }
    if (!userId) {
      throw new AppError('User authentication is required.', 401);
    }
    if (!conversationId || !UUID_RE.test(conversationId)) {
      throw new AppError('Conversation not found.', 404);
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new AppError('Message content is required.', 400);
    }

    const trimmedContent = content.trim();
    const maxLen = env.CHAT_MAX_QUESTION_LENGTH || 1000;
    if (trimmedContent.length > maxLen) {
      throw new AppError(`Message exceeds maximum allowed length of ${maxLen} characters.`, 400);
    }
    if (idempotencyKey !== null && idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0
        || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new AppError(`Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`, 400);
      }
    }

    // Conversation (RLS-scoped) + idempotency lookup + history, in one short read transaction
    const { conversation, existingUserMsg, replay, historyMessages } = await withTenantTransaction(
      organizationId,
      async (client) => {
        const conv = await convRepo.findConversationById(client, conversationId);
        if (!conv) {
          // Same response for "missing" and "belongs to another tenant"
          throw new AppError('Conversation not found.', 404);
        }

        if (idempotencyKey) {
          const existing = await messageRepo.findByIdempotencyKey(client, conversationId, idempotencyKey);
          if (existing) {
            return { conversation: conv, existingUserMsg: existing, replay: await this._findReplay(client, existing) };
          }
        }

        const history = await messageRepo.getConversationMessages(client, conversationId, {
          limit: env.MAX_CONVERSATION_MESSAGES || 10,
        });
        return { conversation: conv, historyMessages: history };
      },
    );

    if (existingUserMsg) {
      if (!replay) {
        // Earlier attempt with this key never completed (disconnect/failure) or is still running.
        // Contract: a key maps to at most one completed answer; retry needs a fresh key.
        throw new AppError(
          'A previous request with this Idempotency-Key did not complete. Retry with a new Idempotency-Key.',
          409,
        );
      }
      return { organizationId, userId, conversation, userMessage: existingUserMsg, replay };
    }

    // Persist the user message (committed before generation; never held open during the LLM call)
    let userMessage;
    try {
      userMessage = await withTenantTransaction(organizationId, async (client) => {
        const msg = await messageRepo.createMessage(client, {
          conversationId,
          organizationId,
          userId,
          role: 'user',
          content: trimmedContent,
          idempotencyKey: idempotencyKey || null,
        });
        await convRepo.touchConversation(client, conversationId);
        return msg;
      });
    } catch (err) {
      if (err.code === '23505' && idempotencyKey) {
        // Concurrent request with the same key won the race
        throw new AppError('A request with this Idempotency-Key is already in progress.', 409);
      }
      throw err;
    }

    return {
      organizationId,
      userId,
      conversation,
      userMessage,
      trimmedContent,
      conversationContext: chatService._buildConversationContext(historyMessages, trimmedContent),
      replay: null,
    };
  }

  /**
   * Streaming phase. Never throws for expected failures — they are emitted as `error` events.
   *
   * @param {object} prepared - Result of prepareStream()
   * @param {object} io
   * @param {AbortSignal} io.signal
   * @param {function(string, object): boolean} io.emit
   * @returns {Promise<{ status: 'completed'|'replayed'|'failed'|'cancelled', code?: string }>}
   */
  async runStream(prepared, { signal, emit }) {
    const { organizationId, userId, conversation, userMessage } = prepared;
    const conversationId = conversation.id;

    if (prepared.replay) {
      return this._emitReplay(prepared, emit);
    }

    emit('start', { conversationId, userMessageId: userMessage.id });
    this._audit(prepared, 'CHAT_STREAM_STARTED', { userMessageId: userMessage.id });

    let accumulated = '';
    let finishReason = 'stop';
    let sources = [];

    try {
      // ── Step 8 grounding: identical path to the non-streaming chat ─────────
      let grounding;
      try {
        grounding = await raceAbort(ragService.prepareGroundedContext({
          organizationId,
          question: prepared.trimmedContent,
          conversationContext: prepared.conversationContext,
        }), signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new StreamFailure('RETRIEVAL_ERROR', err);
      }

      if (!grounding.hasContext) {
        accumulated = ragService.NO_CONTEXT_ANSWER;
        emit('token', { text: accumulated });
      } else {
        sources = grounding.sources;
        ({ accumulated, finishReason } = await this._generate(grounding, signal, emit));
      }

      if (signal.aborted) throw signal.reason;
    } catch (err) {
      return this._handleFailure(prepared, err, signal, emit);
    }

    // ── Persist ONE assistant message + citations atomically ───────────────
    let assistantMessage;
    let citations;
    try {
      ({ assistantMessage, citations } = await withTenantTransaction(organizationId, async (client) => {
        const aMsg = await messageRepo.createMessage(client, {
          conversationId,
          organizationId,
          userId: null,
          role: 'assistant',
          content: accumulated,
          metadata: {
            chunksRetrieved: sources.length,
            topK: env.RAG_TOP_K || 5,
            streamed: true,
            finishReason,
            replyTo: userMessage.id,
          },
        });
        const rows = await citationRepo.createCitations(client, {
          messageId: aMsg.id,
          organizationId,
          sources,
        });
        await convRepo.touchConversation(client, conversationId);
        return { assistantMessage: aMsg, citations: rows };
      }));
    } catch (err) {
      return this._handleFailure(prepared, new StreamFailure('PERSISTENCE_ERROR', err), signal, emit);
    }

    // Committed. Report success even if a timeout fired meanwhile — the data is durable.
    for (const c of citations) {
      emit('citation', toCitationDto(c));
    }
    emit('done', { conversationId, messageId: assistantMessage.id, finishReason });

    this._audit(prepared, 'CHAT_STREAM_COMPLETED', {
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      citationCount: citations.length,
      streamedChars: accumulated.length,
      finishReason,
    });

    return { status: 'completed', assistantMessageId: assistantMessage.id };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Stream tokens from Ollama, enforcing the response-size limit. */
  async _generate(grounding, signal, emit) {
    const maxChars = env.MAX_STREAMED_RESPONSE_CHARS || 10000;
    // Internal controller lets us stop Ollama on size overflow as well as on client abort
    const llmController = new AbortController();
    const forwardAbort = () => llmController.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });

    let accumulated = '';
    let tooLarge = false;

    try {
      const { finishReason } = await ollamaService.generateStream({
        userQuestion: grounding.trimmedQuestion,
        contextText: grounding.fullContextText,
        signal: llmController.signal,
        onToken: (text) => {
          if (tooLarge || llmController.signal.aborted) return;
          if (accumulated.length + text.length > maxChars) {
            tooLarge = true;
            llmController.abort();
            return;
          }
          accumulated += text;
          emit('token', { text });
        },
      });

      if (accumulated.trim().length === 0) {
        accumulated = EMPTY_ANSWER_FALLBACK;
        emit('token', { text: accumulated });
      }
      return { accumulated, finishReason };
    } catch (err) {
      if (tooLarge) throw new StreamFailure('RESPONSE_TOO_LARGE', err);
      if (signal.aborted) throw signal.reason;
      throw new StreamFailure('LLM_STREAM_ERROR', err);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  /** Map any failure to one safe terminal event + one audit record. Nothing is persisted. */
  _handleFailure(prepared, err, signal, emit) {
    const base = { userMessageId: prepared.userMessage.id };

    if (!(err instanceof StreamFailure) && signal.aborted) {
      const code = (signal.reason && signal.reason.code) || ABORT_CODES.CLIENT_DISCONNECTED;
      if (code === ABORT_CODES.STREAM_TIMEOUT) {
        emit('error', { code, message: ABORT_MESSAGES.STREAM_TIMEOUT });
        this._audit(prepared, 'CHAT_STREAM_FAILED', { ...base, code });
        return { status: 'failed', code };
      }
      if (code === ABORT_CODES.SERVER_SHUTTING_DOWN) {
        emit('error', { code, message: ABORT_MESSAGES.SERVER_SHUTTING_DOWN });
      }
      this._audit(prepared, 'CHAT_STREAM_CANCELLED', { ...base, reason: code });
      return { status: 'cancelled', code };
    }

    const code = err instanceof StreamFailure ? err.code : 'INTERNAL_ERROR';
    const internal = err instanceof StreamFailure ? err.cause : err;
    if (code === 'INTERNAL_ERROR' || code === 'PERSISTENCE_ERROR') {
      logger.error(`ChatStream ${code}`, { error: internal });
    }
    emit('error', { code, message: STREAM_ERRORS[code] });
    this._audit(prepared, 'CHAT_STREAM_FAILED', {
      ...base,
      code,
      error: String((internal && internal.message) || '').slice(0, 500),
    });
    return { status: 'failed', code };
  }

  /** Find the committed assistant reply paired with an idempotent user message. */
  async _findReplay(client, userMsg) {
    const messages = await messageRepo.getConversationMessages(client, userMsg.conversation_id);
    // Streamed replies are linked explicitly; fall back to adjacency for Step 9 messages
    let next = messages.find(m => m.role === 'assistant' && m.metadata && m.metadata.replyTo === userMsg.id);
    if (!next) {
      const idx = messages.findIndex(m => m.id === userMsg.id);
      const candidate = idx >= 0 ? messages[idx + 1] : null;
      next = candidate && candidate.role === 'assistant' ? candidate : null;
    }
    if (!next) return null;
    const citations = await citationRepo.getCitationsByMessageId(client, next.id);
    return { assistantMessage: next, citations };
  }

  /** Replay a completed exchange using the same event protocol. No LLM call, no new rows. */
  _emitReplay(prepared, emit) {
    const { conversation, userMessage, replay } = prepared;
    emit('start', { conversationId: conversation.id, userMessageId: userMessage.id, replayed: true });
    emit('token', { text: replay.assistantMessage.content });
    for (const c of replay.citations) {
      emit('citation', toCitationDto(c));
    }
    emit('done', {
      conversationId: conversation.id,
      messageId: replay.assistantMessage.id,
      finishReason: 'replay',
    });
    return { status: 'replayed', assistantMessageId: replay.assistantMessage.id };
  }

  _audit(prepared, action, metadata) {
    auditRepo.log({
      organizationId: prepared.organizationId,
      actorId: prepared.userId,
      action,
      resourceId: prepared.conversation.id,
      metadata,
    }).catch(e => console.warn(`[Audit] ${action} log failed:`, e.message));
  }
}

module.exports = require('../observability/instrument').instrumentChatStream(new ChatStreamService());
module.exports.STREAM_ERRORS = STREAM_ERRORS;
