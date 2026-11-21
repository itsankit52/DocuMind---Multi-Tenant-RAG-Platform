/**
 * Document Repository
 * All methods accept a pg client that operates within a tenant transaction context.
 */

async function createDocument(client, {
  id,
  organizationId,
  uploadedBy,
  filename,
  originalName,
  mimeType,
  fileSize,
  storageKey,
  checksum,
  status = 'uploaded',
}) {
  const query = `
    INSERT INTO documents (
      id, organization_id, uploaded_by, filename, original_name,
      mime_type, file_size, storage_key, checksum, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
    RETURNING *;
  `;
  const values = [
    id,
    organizationId,
    uploadedBy,
    filename,
    originalName,
    mimeType,
    fileSize,
    storageKey,
    checksum,
    status,
  ];
  const { rows } = await client.query(query, values);
  return rows[0];
}

async function findById(client, id) {
  const query = `
    SELECT * FROM documents
    WHERE id = $1 AND deleted_at IS NULL;
  `;
  const { rows } = await client.query(query, [id]);
  return rows[0] || null;
}

async function listByOrganization(client, { page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const query = `
    SELECT *, count(*) OVER() AS total_count
    FROM documents
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2;
  `;
  const { rows } = await client.query(query, [safeLimit, offset]);
  const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

  const documents = rows.map(row => {
    const { total_count, ...doc } = row;
    return doc;
  });

  return {
    documents,
    pagination: {
      page: safePage,
      limit: safeLimit,
      totalCount,
      totalPages: Math.ceil(totalCount / safeLimit),
    },
  };
}

async function softDelete(client, id) {
  const query = `
    UPDATE documents
    SET deleted_at = now(), updated_at = now()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *;
  `;
  const { rows } = await client.query(query, [id]);
  return rows[0] || null;
}

async function updateMetadata(client, id, { filename }) {
  const query = `
    UPDATE documents
    SET filename = COALESCE($2, filename), updated_at = now()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *;
  `;
  const { rows } = await client.query(query, [id, filename]);
  return rows[0] || null;
}

module.exports = {
  createDocument,
  findById,
  listByOrganization,
  softDelete,
  updateMetadata,
};
