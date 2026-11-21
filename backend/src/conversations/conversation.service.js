/**
 * Conversation Service
 * Business logic for conversation lifecycle management.
 * All operations derive organization_id from the authenticated tenant context —
 * never from client-supplied input.
 */

const { withTenantTransaction } = require('../db/transaction');
const convRepo = require('../repositories/conversation.repository');
const messageRepo = require('../repositories/message.repository');
const citationRepo = require('../repositories/citation.repository');
const auditRepo = require('../repositories/audit.repository');
const AppError = require('../utils/AppError');

class ConversationService {
  // ─────────────────────────────────────────────────────────────────────────
  // Create
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new conversation owned by the authenticated user in the current tenant.
   *
   * @param {{ organizationId: string, userId: string, title?: string }} params
   * @returns {Promise<object>} Newly created conversation row
   */
  async createConversation({ organizationId, userId, title }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }
    if (!userId) {
      throw new AppError('User ID is required to create a conversation.', 401);
    }

    const conversation = await withTenantTransaction(organizationId, async (client) => {
      return convRepo.createConversation(client, { organizationId, userId, title });
    });

    // Fire-and-forget audit log — never let logging failure break the request
    auditRepo.log({
      organizationId,
      actorId: userId,
      action: 'CONVERSATION_CREATED',
      resourceId: conversation.id,
      metadata: { title: conversation.title },
    }).catch(err => console.warn('[Audit] CONVERSATION_CREATED log failed:', err.message));

    return conversation;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all non-deleted conversations for the current tenant.
   * Never leaks another tenant's conversations — RLS enforces this at DB level.
   */
  async listConversations({ organizationId, page, limit }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }

    return withTenantTransaction(organizationId, async (client) => {
      return convRepo.listConversations(client, { page, limit });
    });
  }

  /**
   * Retrieve a single conversation by ID within the authenticated tenant.
   * Returns 404 if not found; never reveals whether a foreign tenant's resource exists.
   */
  async getConversation({ organizationId, conversationId }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }
    if (!conversationId) {
      throw new AppError('Conversation ID is required.', 400);
    }

    const conversation = await withTenantTransaction(organizationId, async (client) => {
      return convRepo.findConversationById(client, conversationId);
    });

    if (!conversation) {
      // Return 404 regardless of whether it belongs to another tenant —
      // do not leak existence of foreign resources
      throw new AppError('Conversation not found.', 404);
    }

    return conversation;
  }

  /**
   * Retrieve a conversation and its full message history.
   */
  async getConversationWithMessages({ organizationId, conversationId }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }

    const result = await withTenantTransaction(organizationId, async (client) => {
      const conversation = await convRepo.findConversationById(client, conversationId);
      if (!conversation) return null;

      const messages = await messageRepo.getConversationMessages(client, conversationId);

      // Attach each assistant message's persisted citations (same public fields as the
      // SSE `citation` event) so history keeps its sources after a reload.
      const citationRows = await citationRepo.getCitationsByConversationId(client, conversationId);
      const byMessage = new Map();
      for (const c of citationRows) {
        if (!byMessage.has(c.message_id)) byMessage.set(c.message_id, []);
        byMessage.get(c.message_id).push({
          id: c.id,
          documentId: c.document_id,
          chunkId: c.chunk_id,
          documentName: c.document_name,
          chunkIndex: c.chunk_index,
          page: c.page_number,
          relevanceScore: c.relevance_score,
        });
      }
      const withCitations = messages.map(m => ({ ...m, citations: byMessage.get(m.id) || [] }));

      return { conversation, messages: withCitations };
    });

    if (!result) {
      throw new AppError('Conversation not found.', 404);
    }

    return result;
  }

  /**
   * Retrieve message history for a conversation (used by chat service for context window).
   * Applies the MAX_CONVERSATION_MESSAGES limit.
   */
  async getMessageHistory({ organizationId, conversationId, limit }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }

    return withTenantTransaction(organizationId, async (client) => {
      // Verify the conversation belongs to this tenant
      const conversation = await convRepo.findConversationById(client, conversationId);
      if (!conversation) {
        throw new AppError('Conversation not found.', 404);
      }

      return messageRepo.getConversationMessages(client, conversationId, { limit });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Update
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Rename a conversation. Only title may be changed here.
   * organization_id, user_id, and ownership fields cannot be changed.
   */
  async updateConversation({ organizationId, conversationId, title, userId, role }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }
    if (!conversationId) {
      throw new AppError('Conversation ID is required.', 400);
    }
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new AppError('A non-empty title is required.', 400);
    }

    const updated = await withTenantTransaction(organizationId, async (client) => {
      await this._assertCanModify(client, conversationId, { userId, role });
      return convRepo.updateConversation(client, conversationId, { title: title.trim() });
    });

    if (!updated) {
      throw new AppError('Conversation not found.', 404);
    }

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Delete
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Conversations are shared read/chat spaces inside an organization, but only their creator
   * or an organization admin may rename or delete them. Unknown/foreign ids fall through to
   * the caller's 404 so existence is never revealed.
   */
  async _assertCanModify(client, conversationId, { userId, role }) {
    const conv = await convRepo.findConversationById(client, conversationId);
    if (!conv) return;
    if (role !== 'admin' && conv.user_id !== userId) {
      throw new AppError('Only the conversation owner or an admin can modify this conversation.', 403);
    }
  }

  /**
   * Soft-delete a conversation (sets deleted_at).
   * RLS ensures only the current tenant's conversations are reachable.
   * Never permits cross-tenant deletion.
   */
  async deleteConversation({ organizationId, userId, conversationId, role }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }
    if (!conversationId) {
      throw new AppError('Conversation ID is required.', 400);
    }

    const deleted = await withTenantTransaction(organizationId, async (client) => {
      await this._assertCanModify(client, conversationId, { userId, role });
      return convRepo.softDeleteConversation(client, conversationId);
    });

    if (!deleted) {
      throw new AppError('Conversation not found.', 404);
    }

    auditRepo.log({
      organizationId,
      actorId: userId,
      action: 'CONVERSATION_DELETED',
      resourceId: conversationId,
      metadata: {},
    }).catch(err => console.warn('[Audit] CONVERSATION_DELETED log failed:', err.message));

    return deleted;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message listing (standalone endpoint)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get messages for a conversation, validating tenant ownership first.
   */
  async getMessages({ organizationId, conversationId }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required.', 403);
    }

    return withTenantTransaction(organizationId, async (client) => {
      const conversation = await convRepo.findConversationById(client, conversationId);
      if (!conversation) {
        throw new AppError('Conversation not found.', 404);
      }

      return messageRepo.getConversationMessages(client, conversationId);
    });
  }
}

module.exports = new ConversationService();
