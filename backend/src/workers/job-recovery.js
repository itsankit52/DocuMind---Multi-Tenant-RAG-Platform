/**
 * Stale-job recovery.
 *
 * A worker that dies mid-job (crash, OOM kill, restart, drain timeout) leaves its job in
 * 'processing'. RabbitMQ redelivers the message at once, but the job's lock is still fresh, so
 * the claim fails and that delivery is acked; the outbox event is already 'published'.
 * Without this sweep nothing would ever pick the job up again.
 *
 * Each sweep (Phase 3.4 / F2: no BYPASSRLS needed):
 *  - discovers candidate (job_id, organization_id) pairs across tenants through the read-only
 *    SECURITY DEFINER function worker_stale_job_candidates() (migration 013), which only lists
 *    ids and never decides or locks anything;
 *  - then handles EACH candidate in its own withTenantTransaction(organization_id) — RLS-scoped,
 *    atomic per job — re-checking the same staleness rule under FOR UPDATE SKIP LOCKED. The rule
 *    selects jobs that are provably abandoned: 'processing' with an expired lock, or
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
const { withTenantTransaction } = require('../db/transaction');
const env = require('../config/env');
const outboxRepo = require('../repositories/outbox.repository');
const auditRepo = require('../repositories/audit.repository');
const logger = require('../observability/logger');
const { metrics, safe } = require('../observability/metrics');

// Runs inside the candidate's tenant transaction (RLS): re-checks the staleness rule for ONE job
// under its row lock. A job taken by a live run, another sweeper, or no longer stale is skipped.
const RECOVER_ONE_SQL = `
  WITH stale AS (
    SELECT j.id,
           j.status AS previous_status,
           EXISTS (
             SELECT 1 FROM document_processing_jobs n
             WHERE n.document_id = j.document_id AND n.id <> j.id AND n.created_at > j.created_at
           ) AS superseded
    FROM document_processing_jobs j
    WHERE j.id = $2
      AND ((j.status = 'processing'
            AND COALESCE(j.locked_at, j.updated_at) < now() - make_interval(mins => $1::int))
        OR (j.status IN ('pending', 'queued', 'retrying')
            AND j.updated_at < now() - make_interval(mins => $1::int)))
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

const CANDIDATES_SQL = 'SELECT job_id, organization_id FROM public.worker_stale_job_candidates($1, $2)';

/** Same tenant transaction as the job update: the audit commits or rolls back with it. */
async function audit(client, job, action, metadata) {
  await auditRepo.log({
    organizationId: job.organization_id, actorId: null, action, resourceId: job.document_id, metadata,
  }, client);
}

/** Recover one candidate inside its own tenant transaction. Returns the job row or null. */
async function recoverOne(candidate, { lockTimeoutMinutes, maxAttempts }) {
  return withTenantTransaction(candidate.organization_id, async (client) => {
    const { rows: [job] } = await client.query(RECOVER_ONE_SQL, [lockTimeoutMinutes, candidate.job_id, maxAttempts]);
    if (!job) return null;
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
    return job;
  });
}

/**
 * Run one recovery sweep.
 * @returns {Promise<{ requeued: number, failed: number, superseded: number, jobs: object[] }>}
 */
async function recoverStaleJobs({
  lockTimeoutMinutes = env.JOB_LOCK_TIMEOUT_MINUTES,
  limit = env.JOB_RECOVERY_BATCH_SIZE,
} = {}) {
  const maxAttempts = env.MAX_PROCESSING_ATTEMPTS || 3;
  // Discovery only (ids); every decision and write happens per job under RLS below.
  const { rows: candidates } = await pool.query(CANDIDATES_SQL, [lockTimeoutMinutes, limit]);
  const jobs = [];
  for (const candidate of candidates) {
    // A failure rolls back only this job (atomic per job) and ends the sweep; the next sweep retries.
    const job = await recoverOne(candidate, { lockTimeoutMinutes, maxAttempts });
    if (job) jobs.push(job);
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
