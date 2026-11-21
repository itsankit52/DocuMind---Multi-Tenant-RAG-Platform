/**
 * Chunk Repository
 * Handles operations on the document_chunks table.
 */

async function insertChunks(client, { organizationId, documentId, chunks }) {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  // Construct bulk insert values
  const valueRows = [];
  const queryParams = [];
  let paramIdx = 1;

  for (const chunk of chunks) {
    valueRows.push(
      `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, now(), now())`
    );
    queryParams.push(
      organizationId,
      documentId,
      chunk.chunkIndex,
      chunk.content,
      chunk.pageStart || null,
      chunk.pageEnd || null,
      chunk.characterCount
    );
  }

  const query = `
    INSERT INTO document_chunks (
      organization_id, document_id, chunk_index, content, page_start, page_end, character_count, created_at, updated_at
    ) VALUES ${valueRows.join(', ')}
    ON CONFLICT (document_id, chunk_index) DO UPDATE
    SET content = EXCLUDED.content,
        page_start = EXCLUDED.page_start,
        page_end = EXCLUDED.page_end,
        character_count = EXCLUDED.character_count,
        updated_at = now()
    RETURNING *;
  `;

  const { rows } = await client.query(query, queryParams);
  return rows;
}

async function deleteByDocumentId(client, documentId) {
  const query = `
    DELETE FROM document_chunks
    WHERE document_id = $1;
  `;
  const { rowCount } = await client.query(query, [documentId]);
  return rowCount;
}

async function listByDocumentId(client, documentId) {
  const query = `
    SELECT * FROM document_chunks
    WHERE document_id = $1
    ORDER BY chunk_index ASC;
  `;
  const { rows } = await client.query(query, [documentId]);
  return rows;
}

async function countByDocumentId(client, documentId) {
  const query = `
    SELECT count(*)::int AS count FROM document_chunks
    WHERE document_id = $1;
  `;
  const { rows } = await client.query(query, [documentId]);
  return rows[0] ? rows[0].count : 0;
}

async function markChunksEmbedded(client, chunkIds) {
  if (!chunkIds || chunkIds.length === 0) return 0;
  const query = `
    UPDATE document_chunks
    SET embedded_at = now(), updated_at = now()
    WHERE id = ANY($1::uuid[]);
  `;
  const { rowCount } = await client.query(query, [chunkIds]);
  return rowCount;
}

async function findChunksWithDocumentByIds(client, chunkIds) {
  if (!chunkIds || chunkIds.length === 0) return [];
  const query = `
    SELECT 
      c.id AS chunk_id,
      c.organization_id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.page_start,
      c.page_end,
      c.character_count,
      d.filename,
      d.original_name,
      d.status AS document_status
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.id = ANY($1::uuid[])
      AND d.deleted_at IS NULL
      AND d.status = 'ready';
  `;
  const { rows } = await client.query(query, [chunkIds]);
  return rows;
}

module.exports = {
  insertChunks,
  deleteByDocumentId,
  listByDocumentId,
  countByDocumentId,
  markChunksEmbedded,
  findChunksWithDocumentByIds,
};
