/**
 * Citation Repository
 * Persists source citations produced by the RAG pipeline against an assistant message.
 * All methods accept a pg client operating within a withTenantTransaction context.
 * RLS on the citations table enforces organization_id isolation automatically.
 *
 * Maps from RAG service source objects:
 *   { documentId, chunkId, documentName, chunkIndex, pageStart, score }
 * to citations table columns:
 *   { message_id, document_id, organization_id, chunk_id, chunk_index,
 *     document_name, page_number, relevance_score, created_at }
 *
 * Deliberately does NOT store:
 *   - raw embeddings
 *   - Qdrant internal payloads
 *   - system prompts or model configuration
 */

/**
 * Persist all citations for an assistant message in a single bulk INSERT.
 *
 * @param {object} client - Tenant transaction client
 * @param {object} params
 * @param {string} params.messageId      - The assistant message these citations belong to
 * @param {string} params.organizationId - Must come from tenant context
 * @param {Array}  params.sources        - RAG service sources array
 * @returns {Promise<Array>} Inserted citation rows
 */
async function createCitations(client, { messageId, organizationId, sources }) {
  if (!sources || sources.length === 0) return [];

  const valueRows = [];
  const params = [];
  let idx = 1;

  for (const source of sources) {
    valueRows.push(
      `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, now())`,
    );
    params.push(
      messageId,                                            // message_id
      source.documentId || null,                           // document_id
      organizationId,                                      // organization_id
      source.chunkId || null,                              // chunk_id
      typeof source.chunkIndex === 'number'
        ? source.chunkIndex : 0,                           // chunk_index
      source.documentName || null,                         // document_name
      source.pageStart || null,                            // page_number (use pageStart)
      typeof source.score === 'number' ? source.score : null, // relevance_score
    );
  }

  const query = `
    INSERT INTO citations
      (message_id, document_id, organization_id, chunk_id,
       chunk_index, document_name, page_number, relevance_score, created_at)
    VALUES ${valueRows.join(', ')}
    RETURNING *
  `;

  const { rows } = await client.query(query, params);
  return rows;
}

/**
 * Retrieve all citations for a specific message.
 * Returns only safe display fields — no raw embeddings or internal payloads.
 */
async function getCitationsByMessageId(client, messageId) {
  const { rows } = await client.query(
    `SELECT
       id,
       message_id,
       document_id,
       organization_id,
       chunk_id,
       chunk_index,
       document_name,
       page_number,
       relevance_score,
       created_at
     FROM citations
     WHERE message_id = $1
     ORDER BY relevance_score DESC NULLS LAST, chunk_index ASC`,
    [messageId],
  );
  return rows;
}

/**
 * Retrieve citations for all assistant messages in a conversation.
 * Useful for loading full conversation history with sources.
 */
async function getCitationsByConversationId(client, conversationId) {
  const { rows } = await client.query(
    `SELECT
       c.id,
       c.message_id,
       c.document_id,
       c.chunk_id,
       c.chunk_index,
       c.document_name,
       c.page_number,
       c.relevance_score,
       c.created_at
     FROM citations c
     JOIN messages m ON m.id = c.message_id
     WHERE m.conversation_id = $1
     ORDER BY m.created_at ASC, c.relevance_score DESC NULLS LAST`,
    [conversationId],
  );
  return rows;
}

module.exports = {
  createCitations,
  getCitationsByMessageId,
  getCitationsByConversationId,
};
