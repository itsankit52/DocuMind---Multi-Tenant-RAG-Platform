/**
 * Stale-job recovery.
 *
 * A worker that dies mid-job (crash, OOM kill, restart, drain timeout) leaves its job in
 * 'processing'. RabbitMQ redelivers the message at once, but the job's lock is still fresh, so
 * the claim fails and that delivery is acked; the outbox event is already 'published'.
 * Without this sweep nothing would ever pick the job up again.
 *
 * Each sweep, in one transaction:
 *  - selects jobs that are provably abandoned: 'processing' with an expired lock, or
 *    'pending'/'queued'/'retrying' untouched for the lock timeout (their message was lost or
 *    dead-lettered). FOR UPDATE SKIP LOCKED skips rows locked by a live processing run (the
 *    processor holds its job row for the whole run) and rows another sweeper is handling, so
 *    concurrent workers never recover the same job and a slow live job is never touched;
 *  - requeues a job through the transactional outbox (status 'retrying'; the outbox relay
 *    publishes it). The payload is built only from the job row, never from other input;
 *  - fails a job that already used max_attempts, and marks its document 'failed' (scoped by
 *    the job's own organization) so the UI offers Retry. A document still 'ready' from an
 *    earlier run is left as is;
 *  - fails a job superseded by a newer job for the same document without touching the
 *    document, so the same document is not processed twice.
 * Every claim increments attempts, so a job that keeps killing its worker ends 'failed'.
 */

const { pool } = require('../db');
const env = require('../config/env');
const outboxRepo = require('../repositories/outbox.repository');
const logger = require('../observability/logger');
const { metrics, safe } = require('../observability/metrics');

const RECOVER_SQL = `
  WITH stale AS (
    SELECT j.id,
           j.status AS previous_status,
           EXISTS (
             SELECT 1 FROM document_processing_jobs n
             WHERE n.document_id = j.document_id AND n.id <> j.id AND n.created_at > j.created_at
           ) AS superseded
    FROM document_processing_jobs j
    WHERE (j.status = 'processing'
           AND COALESCE(j.locked_at, j.updated_at) < now() - make_interval(mins => $1::int))
       OR (j.status IN ('pending', 'queued', 'retrying')
           AND j.updated_at < now() - make_interval(mins => $1::int))
    ORDER BY j.updated_at
    LIMIT $2
    FOR UPDATE OF j SKIP LOCKED
  ), decided AS (
    SELECT s.*, (s.superseded OR j.attempts >= COALESCE(j.max_attempts, $3::int)) AS give_up
    FROM stale s JOIN document_processing_jobs j ON j.id = s.id
  )
  UPDATE document_processing_jobs j
  SET status = CASE WHEN d.give_up THEN 'failed' ELSE 'retrying' END,
      worker_id = NULL,
      locked_at = NULL,
      updated_at = now(),
      finished_at = CASE WHEN d.give_up THEN now() ELSE j.finished_at END,
      error_log = CASE
        WHEN d.superseded THEN 'Abandoned job superseded by a newer processing job for this document.'
        WHEN d.give_up THEN 'Processing abandoned: worker lost after ' || j.attempts || ' attempt(s).'
        ELSE j.error_log
      END
  FROM decided d
  WHERE j.id = d.id
  RETURNING j.id, j.organization_id, j.document_id, j.status, j.attempts, j.max_attempts,
            d.previous_status, d.superseded;
`;

function outcomeOf(job) {
  if (job.status === 'retrying') return 'requeued';
  return job.superseded ? 'superseded' : 'failed';
}

async function audit(client, job, action, metadata) {
  await client.query(
    'INSERT INTO audit_logs (organization_id, actor_id, action, resource_id, metadata) VALUES ($1, NULL, $2, $3, $4)',
    [job.organization_id, action, job.document_id, metadata],
  );
}

/**
 * Run one recovery sweep.
 * @returns {Promise<{ requeued: number, failed: number, superseded: number, jobs: object[] }>}
 */
async function recoverStaleJobs({
  lockTimeoutMinutes = env.JOB_LOCK_TIMEOUT_MINUTES,
  limit = env.JOB_RECOVERY_BATCH_SIZE,
} = {}) {
  const client = await pool.connect();
  let jobs;
  try {
    await client.query('BEGIN');
    ({ rows: jobs } = await client.query(RECOVER_SQL, [lockTimeoutMinutes, limit, env.MAX_PROCESSING_ATTEMPTS || 3]));

    for (const job of jobs) {
      const outcome = outcomeOf(job);
      const metadata = {
        jobId: job.id,
        previousStatus: job.previous_status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        outcome,
      };

      if (outcome === 'requeued') {
        await outboxRepo.createEvent(client, {
          organizationId: job.organization_id,
          aggregateType: 'document',
          aggregateId: job.document_id,
          eventType: 'document.process',
          payload: {
            event: 'document.process',
            jobId: job.id,
            documentId: job.document_id,
            organizationId: job.organization_id,
            version: 1,
            recovered: true,
          },
        });
        await audit(client, job, 'DOCUMENT_PROCESSING_RECOVERED', metadata);
      } else if (outcome === 'failed') {
        await client.query(
          `UPDATE documents SET status = 'failed', updated_at = now()
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND status <> 'ready'`,
          [job.document_id, job.organization_id],
        );
        await audit(client, job, 'DOCUMENT_PROCESSING_FAILED', { ...metadata, reason: 'abandoned' });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const summary = { requeued: 0, failed: 0, superseded: 0, jobs };
  for (const job of jobs) {
    const outcome = outcomeOf(job);
    summary[outcome] += 1;
    safe(() => metrics.processingJobsRecovered.inc({ outcome }));
    logger.warn('Recovered abandoned processing job', {
      jobId: job.id,
      organizationId: job.organization_id,
      documentId: job.document_id,
      previousStatus: job.previous_status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      outcome,
    });
  }
  return summary;
}

/**
 * Periodic sweep loop. Returns a stop() function.
 */
function startJobRecovery({ intervalMs = env.JOB_RECOVERY_INTERVAL_MS, ...options } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await recoverStaleJobs(options);
    } catch (err) {
      logger.error('Stale-job recovery sweep failed', { error: err });
    } finally {
      running = false;
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { recoverStaleJobs, startJobRecovery };
