/**
 * Message Repository
 * All methods accept a pg client operating within a withTenantTransaction context.
 * RLS on the messages table enforces organization_id isolation automatically.
 *
 * Role enforcement:
 *   - role must be 'user' or 'assistant' (enforced by DB CHECK constraint too)
 *   - user_id is set for 'user' messages, NULL for 'assistant' messages
 *   - idempotency_key is set on 'user' messages to prevent duplicate submissions
 */

/**
 * Persist a single message.
 *
 * @param {object} client - Tenant transaction client
 * @param {object} params
 * @param {string} params.conversationId
 * @param {string} params.organizationId  - Must come from tenant context, never client input
 * @param {string|null} params.userId     - NULL for assistant messages
 * @param {'user'|'assistant'} params.role
 * @param {string} params.content
 * @param {string|null} params.idempotencyKey - Only for 'user' messages
 * @param {object|null} params.metadata
 * @returns {Promise<object>} Persisted message row
 */
async function createMessage(client, {
  conversationId,
  organizationId,
  userId = null,
  role,
  content,
  idempotencyKey = null,
  metadata = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO messages
       (conversation_id, organization_id, user_id, role, content, idempotency_key, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING *`,
    [
      conversationId,
      organizationId,
      userId,
      role,
      content,
      idempotencyKey || null,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
  return rows[0];
}

/**
 * Retrieve all messages for a conversation, ordered chronologically.
 * RLS ensures the conversation and its messages belong to the current tenant.
 *
 * @param {object} client
 * @param {string} conversationId
 * @param {object} [opts]
 * @param {number} [opts.limit]  - Max messages to return (for context window)
 * @returns {Promise<Array>}
 */
async function getConversationMessages(client, conversationId, { limit } = {}) {
  if (limit && limit > 0) {
    // Return the N most recent messages, but in ascending order for display
    const { rows } = await client.query(
      `SELECT * FROM (
         SELECT * FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) sub
       ORDER BY created_at ASC`,
      [conversationId, limit],
    );
    return rows;
  }

  const { rows } = await client.query(
    `SELECT * FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );
  return rows;
}

/**
 * Find a single message by ID within the current tenant context.
 */
async function findMessageById(client, messageId) {
  const { rows } = await client.query(
    `SELECT * FROM messages WHERE id = $1`,
    [messageId],
  );
  return rows[0] || null;
}

/**
 * Check if a message with a given idempotency key already exists
 * within this conversation. Used to detect duplicate submissions.
 *
 * @param {object} client
 * @param {string} conversationId
 * @param {string} idempotencyKey
 * @returns {Promise<object|null>} Existing message or null
 */
async function findByIdempotencyKey(client, conversationId, idempotencyKey) {
  const { rows } = await client.query(
    `SELECT * FROM messages
     WHERE conversation_id = $1
       AND idempotency_key = $2
     LIMIT 1`,
    [conversationId, idempotencyKey],
  );
  return rows[0] || null;
}

/**
 * Count messages in a conversation (for limit enforcement).
 */
async function countMessages(client, conversationId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1`,
    [conversationId],
  );
  return rows[0] ? rows[0].count : 0;
}

module.exports = {
  createMessage,
  getConversationMessages,
  findMessageById,
  findByIdempotencyKey,
  countMessages,
};
