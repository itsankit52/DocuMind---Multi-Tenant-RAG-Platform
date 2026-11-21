/**
 * Conversation Repository
 * All methods accept a pg client operating within a withTenantTransaction context.
 * RLS on the conversations table enforces organization_id isolation automatically.
 * Never accepts organization_id from client input — caller must supply from
 * the authenticated tenant context.
 */

/**
 * Create a new conversation.
 */
async function createConversation(client, { organizationId, userId, title }) {
  const safeTitle = (title || 'New Chat').toString().trim().slice(0, 255) || 'New Chat';

  const { rows } = await client.query(
    `INSERT INTO conversations (organization_id, user_id, title, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     RETURNING *`,
    [organizationId, userId, safeTitle],
  );
  return rows[0];
}

/**
 * Find a single non-deleted conversation by ID.
 * RLS ensures only the authenticated tenant's rows are visible.
 */
async function findConversationById(client, conversationId) {
  const { rows } = await client.query(
    `SELECT * FROM conversations
     WHERE id = $1 AND deleted_at IS NULL`,
    [conversationId],
  );
  return rows[0] || null;
}

/**
 * List non-deleted conversations for the current tenant.
 * Ordered by updated_at DESC (most recently active first).
 * Supports cursor-based pagination via page/limit.
 */
async function listConversations(client, { page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const { rows } = await client.query(
    `SELECT *, count(*) OVER() AS total_count
     FROM conversations
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT $1 OFFSET $2`,
    [safeLimit, offset],
  );

  const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
  const conversations = rows.map(({ total_count, ...conv }) => conv);

  return {
    conversations,
    pagination: {
      page: safePage,
      limit: safeLimit,
      totalCount,
      totalPages: Math.ceil(totalCount / safeLimit),
    },
  };
}

/**
 * Update a conversation's mutable fields (title only for now).
 * Returns null if the conversation does not exist or is deleted.
 */
async function updateConversation(client, conversationId, { title }) {
  const safeTitle = (title || '').toString().trim().slice(0, 255);
  if (!safeTitle) return null;

  const { rows } = await client.query(
    `UPDATE conversations
     SET title = $2, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [conversationId, safeTitle],
  );
  return rows[0] || null;
}

/**
 * Touch updated_at on a conversation (called after a new message is added).
 */
async function touchConversation(client, conversationId) {
  await client.query(
    `UPDATE conversations
     SET updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [conversationId],
  );
}

/**
 * Soft-delete a conversation.
 * Cascades are handled at DB level (messages/citations cascade-delete on hard delete,
 * but soft delete leaves messages intact and just hides the conversation).
 */
async function softDeleteConversation(client, conversationId) {
  const { rows } = await client.query(
    `UPDATE conversations
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [conversationId],
  );
  return rows[0] || null;
}

module.exports = {
  createConversation,
  findConversationById,
  listConversations,
  updateConversation,
  touchConversation,
  softDeleteConversation,
};
