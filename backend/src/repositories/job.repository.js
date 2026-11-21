const { pool } = require('../db');
const env = require('../config/env');

/**
 * Job Repository
 * Handles operations on the document_processing_jobs table.
 */

async function createJob(client, {
  id,
  documentId,
  organizationId,
  stage = 'text_extraction',
  status = 'queued',
  maxAttempts = 3,
}) {
  const query = `
    INSERT INTO document_processing_jobs (
      id, document_id, organization_id, stage, status, attempts, max_attempts, created_at, updated_at
    ) VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, 0, $6, now(), now())
    RETURNING *;
  `;
  const values = [id, documentId, organizationId, stage, status, maxAttempts];
  const { rows } = await client.query(query, values);
  return rows[0];
}

async function findById(client, jobId) {
  const query = `
    SELECT * FROM document_processing_jobs
    WHERE id = $1;
  `;
  const { rows } = await client.query(query, [jobId]);
  return rows[0] || null;
}

async function findByDocumentId(client, documentId) {
  const query = `
    SELECT * FROM document_processing_jobs
    WHERE document_id = $1
    ORDER BY created_at DESC;
  `;
  const { rows } = await client.query(query, [documentId]);
  return rows;
}

async function getLatestByDocumentId(client, documentId) {
  const query = `
    SELECT * FROM document_processing_jobs
    WHERE document_id = $1
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  const { rows } = await client.query(query, [documentId]);
  return rows[0] || null;
}

/**
 * Claims a job for a worker using row-level locking (SELECT ... FOR UPDATE).
 * Transitions to 'processing' if currently 'pending', 'queued' or 'retrying' — or if it is
 * 'processing' but its lock is older than JOB_LOCK_TIMEOUT_MINUTES (the previous worker
 * crashed or was killed mid-job), so a redelivered message can recover it.
 */
async function claimJob(client, jobId, workerId) {
  const query = `
    UPDATE document_processing_jobs
    SET status = 'processing',
        worker_id = $2,
        locked_at = now(),
        started_at = COALESCE(started_at, now()),
        attempts = attempts + 1,
        updated_at = now()
    WHERE id = $1
      AND (
        status IN ('pending', 'queued', 'retrying')
        -- Recover jobs whose worker crashed or was killed mid-run (lock expired)
        OR (status = 'processing'
            AND COALESCE(locked_at, updated_at) < now() - make_interval(mins => $3::int))
      )
    RETURNING *;
  `;
  const { rows } = await client.query(query, [jobId, workerId, env.JOB_LOCK_TIMEOUT_MINUTES]);
  return rows[0] || null;
}

/**
 * Lock a claimed job row for the rest of the caller's transaction. A live processing run
 * holds this lock until it commits or rolls back; stale-job recovery skips locked rows, so a
 * job is only ever recovered once its worker is really gone. Returns null if this worker no
 * longer owns the claim.
 */
async function lockForProcessing(client, jobId, workerId) {
  const { rows } = await client.query(
    `SELECT id FROM document_processing_jobs
     WHERE id = $1 AND status = 'processing' AND worker_id = $2
     FOR UPDATE`,
    [jobId, workerId],
  );
  return rows[0] || null;
}

async function updateJobStatus(client, jobId, { status = null, stage = null, errorLog = null, finishedAt = null }) {
  const query = `
    UPDATE document_processing_jobs
    SET status = COALESCE($2::text, status),
        stage = COALESCE($3, stage),
        error_log = COALESCE($4, error_log),
        finished_at = COALESCE($5, finished_at),
        locked_at = CASE WHEN $2::text IS NULL THEN locked_at ELSE NULL END,
        updated_at = now()
    WHERE id = $1
    RETURNING *;
  `;
  const { rows } = await client.query(query, [jobId, status, stage, errorLog, finishedAt]);
  return rows[0] || null;
}

module.exports = {
  createJob,
  findById,
  findByDocumentId,
  getLatestByDocumentId,
  claimJob,
  lockForProcessing,
  updateJobStatus,
};
