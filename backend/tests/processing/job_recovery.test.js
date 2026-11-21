/**
 * Regression tests for C1 (audit batch 1): jobs stuck in 'processing' after a worker dies.
 *
 * Before the fix, a redelivered message for a job whose worker died was acked because the
 * job's lock was still fresh, the outbox event was already 'published', and nothing ever
 * picked the job up again. Stale-job recovery requeues (or fails) only provably abandoned jobs.
 *
 * Uses the isolated test database and test queues only.
 */

const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const supertest = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { pool } = require('../../src/db');
const { withTenantTransaction } = require('../../src/db/transaction');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const qdrantService = require('../../src/vector/qdrant.service');
const { relayPendingOutbox } = require('../../src/queue/outbox.relay');
const { recoverStaleJobs } = require('../../src/workers/job-recovery');
const DocumentProcessor = require('../../src/workers/processor');
const DocumentWorker = require('../../src/workers/document.worker');
const { createTestPdf } = require('../fixtures/document.fixtures');
const { metricValue } = require('../observability/obs.helpers');
const h = require('../streaming/stream.helpers');

const BACKEND_DIR = path.join(__dirname, '../..');
const LOCK_MIN = env.JOB_LOCK_TIMEOUT_MINUTES;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let A;
let B;

async function insertDoc(org, status = 'uploaded') {
  const { rows } = await pool.query(
    `INSERT INTO documents (organization_id, uploaded_by, filename, original_name, mime_type, file_size, storage_key, status)
     VALUES ($1, $2, 'f.pdf', 'f.pdf', 'application/pdf', 10, 'k', $3) RETURNING *`,
    [org.orgId, org.users.admin.id, status],
  );
  return rows[0];
}

/** Insert a job; ages are in minutes before now(). */
async function insertJob({ orgId, documentId, status, attempts = 1, maxAttempts = 3, lockedAgo = null, updatedAgo = 0, createdAgo = updatedAgo }) {
  const { rows } = await pool.query(
    `INSERT INTO document_processing_jobs
       (organization_id, document_id, stage, status, attempts, max_attempts, worker_id,
        locked_at, updated_at, created_at)
     VALUES ($1, $2, 'embedding', $3::varchar, $4, $5, CASE WHEN $3::varchar = 'processing' THEN 'dead-worker' END,
        CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(mins => $6::int) END,
        now() - make_interval(mins => $7::int), now() - make_interval(mins => $8::int))
     RETURNING *`,
    [orgId, documentId, status, attempts, maxAttempts, lockedAgo, updatedAgo, createdAgo],
  );
  return rows[0];
}

const job = async (id) => (await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [id])).rows[0];
const doc = async (id) => (await pool.query('SELECT * FROM documents WHERE id = $1', [id])).rows[0];
const outboxFor = async (jobId) => (await pool.query(
  "SELECT * FROM outbox_events WHERE payload->>'jobId' = $1", [jobId])).rows;

beforeAll(async () => {
  await h.truncateAll();
  A = await h.createOrgWithUsers('recovery-a', ['admin']);
  B = await h.createOrgWithUsers('recovery-b', ['admin']);
});

afterAll(async () => {
  await h.truncateAll();
  await rabbitmqService.close().catch(() => {});
  await pool.end();
});

describe('Stale-job recovery rules', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE documents, document_processing_jobs, document_chunks, outbox_events, audit_logs CASCADE');
  });

  test('expired processing lock: requeued through a pending outbox event built from the job row', async () => {
    const d = await insertDoc(A);
    const j = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'processing', lockedAgo: LOCK_MIN + 1, updatedAgo: LOCK_MIN + 1 });
    const before = await metricValue('document_processing_jobs_recovered_total', { outcome: 'requeued' });

    const result = await recoverStaleJobs();

    expect(result.requeued).toBe(1);
    const after = await job(j.id);
    expect(after).toMatchObject({ status: 'retrying', worker_id: null, locked_at: null, attempts: 1 });
    const events = await outboxFor(j.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'pending', organization_id: A.orgId, aggregate_id: d.id, event_type: 'document.process' });
    expect(events[0].payload).toMatchObject({ jobId: j.id, documentId: d.id, organizationId: A.orgId, recovered: true });
    expect(await metricValue('document_processing_jobs_recovered_total', { outcome: 'requeued' })).toBe(before + 1);
    const { rows: audits } = await pool.query("SELECT * FROM audit_logs WHERE action = 'DOCUMENT_PROCESSING_RECOVERED'");
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ jobId: j.id, previousStatus: 'processing', outcome: 'requeued' });
  });

  test('fresh locks, recent jobs and terminal jobs are left alone', async () => {
    const d = await insertDoc(A);
    const fresh = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'processing', lockedAgo: 1, updatedAgo: 1, createdAgo: 50 });
    const queued = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'queued', attempts: 0, updatedAgo: 1, createdAgo: 49 });
    const done = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'completed', updatedAgo: 90, createdAgo: 48 });
    const failed = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'failed', updatedAgo: 90, createdAgo: 47 });

    expect((await recoverStaleJobs()).jobs).toHaveLength(0);
    for (const j of [fresh, queued, done, failed]) expect((await job(j.id)).status).toBe(j.status);
    expect((await pool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(0);
  });

  test('a job held by a live processing transaction is never recovered, however old its lock', async () => {
    const d = await insertDoc(A);
    const j = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'processing', lockedAgo: LOCK_MIN * 3, updatedAgo: LOCK_MIN * 3 });
    const live = await pool.connect();
    try {
      await live.query('BEGIN');
      await live.query('SELECT id FROM document_processing_jobs WHERE id = $1 FOR UPDATE', [j.id]); // what the processor holds
      expect((await recoverStaleJobs()).jobs).toHaveLength(0);
      expect((await job(j.id)).status).toBe('processing');
    } finally {
      await live.query('ROLLBACK');
      live.release();
    }
    // Once the "worker" is gone (lock released) the job is recovered
    expect((await recoverStaleJobs()).requeued).toBe(1);
  });

  test('exhausted attempts: job failed; document failed unless it is still ready from an earlier run', async () => {
    const d1 = await insertDoc(A, 'uploaded');
    const d2 = await insertDoc(A, 'ready');
    const j1 = await insertJob({ orgId: A.orgId, documentId: d1.id, status: 'processing', attempts: 3, maxAttempts: 3, lockedAgo: LOCK_MIN + 5, updatedAgo: LOCK_MIN + 5 });
    const j2 = await insertJob({ orgId: A.orgId, documentId: d2.id, status: 'processing', attempts: 3, maxAttempts: 3, lockedAgo: LOCK_MIN + 5, updatedAgo: LOCK_MIN + 5 });
    const before = await metricValue('document_processing_jobs_recovered_total', { outcome: 'failed' });

    const result = await recoverStaleJobs();

    expect(result.failed).toBe(2);
    for (const id of [j1.id, j2.id]) {
      const after = await job(id);
      expect(after.status).toBe('failed');
      expect(after.finished_at).not.toBeNull();
      expect(after.error_log).toMatch(/worker lost after 3 attempt/);
      expect(await outboxFor(id)).toHaveLength(0);
    }
    expect((await doc(d1.id)).status).toBe('failed'); // UI now offers Retry
    expect((await doc(d2.id)).status).toBe('ready'); // previous successful run still serves answers
    expect(await metricValue('document_processing_jobs_recovered_total', { outcome: 'failed' })).toBe(before + 2);
  });

  test('a job superseded by a newer job for the same document is failed, not reprocessed', async () => {
    const d = await insertDoc(A, 'uploaded');
    const old = await insertJob({ orgId: A.orgId, documentId: d.id, status: 'processing', lockedAgo: LOCK_MIN + 2, updatedAgo: LOCK_MIN + 2, createdAgo: LOCK_MIN + 10 });
    await insertJob({ orgId: A.orgId, documentId: d.id, status: 'queued', attempts: 0, updatedAgo: 1, createdAgo: 1 });

    const result = await recoverStaleJobs();

    expect(result.superseded).toBe(1);
    expect(await job(old.id)).toMatchObject({ status: 'failed' });
    expect((await job(old.id)).error_log).toMatch(/superseded/);
    expect(await outboxFor(old.id)).toHaveLength(0);
    expect((await doc(d.id)).status).toBe('uploaded'); // the newer job owns the document
  });

  test('queued/retrying jobs whose message was lost are requeued', async () => {
    const d1 = await insertDoc(A);
    const d2 = await insertDoc(A);
    const q = await insertJob({ orgId: A.orgId, documentId: d1.id, status: 'queued', attempts: 0, updatedAgo: LOCK_MIN + 1 });
    const r = await insertJob({ orgId: A.orgId, documentId: d2.id, status: 'retrying', attempts: 2, updatedAgo: LOCK_MIN + 1 });

    expect((await recoverStaleJobs()).requeued).toBe(2);
    expect((await job(q.id)).status).toBe('retrying');
    expect(await outboxFor(q.id)).toHaveLength(1);
    expect(await outboxFor(r.id)).toHaveLength(1);
  });

  test('concurrent sweeps (several workers) never recover the same job twice', async () => {
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const d = await insertDoc(i % 2 ? A : B);
      const j = await insertJob({ orgId: d.organization_id, documentId: d.id, status: 'processing', lockedAgo: LOCK_MIN + 1, updatedAgo: LOCK_MIN + 1 });
      ids.push(j.id);
    }

    const results = await Promise.all([1, 2, 3, 4].map(() => recoverStaleJobs({ limit: 50 })));

    const recovered = results.flatMap(r => r.jobs.map(j => j.id));
    expect(recovered).toHaveLength(30);
    expect(new Set(recovered).size).toBe(30);
    const { rows } = await pool.query(
      "SELECT payload->>'jobId' AS job_id, count(*)::int AS n FROM outbox_events GROUP BY 1");
    expect(rows).toHaveLength(30);
    expect(rows.every(r => r.n === 1)).toBe(true);
    expect(new Set(rows.map(r => r.job_id))).toEqual(new Set(ids));
  });

  test('tenant isolation: recovery keeps each job in its own organization', async () => {
    const dA = await insertDoc(A, 'uploaded');
    const dB = await insertDoc(B, 'uploaded');
    const jA = await insertJob({ orgId: A.orgId, documentId: dA.id, status: 'processing', lockedAgo: LOCK_MIN + 1, updatedAgo: LOCK_MIN + 1 });
    const jB = await insertJob({ orgId: B.orgId, documentId: dB.id, status: 'processing', lockedAgo: LOCK_MIN + 1, updatedAgo: LOCK_MIN + 1 });
    // Corrupt rows: jobs of org B that point at org A's document
    const dA2 = await insertDoc(A, 'uploaded');
    const dA3 = await insertDoc(A, 'uploaded');
    const badExhausted = await insertJob({ orgId: B.orgId, documentId: dA2.id, status: 'processing', attempts: 3, maxAttempts: 3, lockedAgo: LOCK_MIN + 1, updatedAgo: LOCK_MIN + 1 });
    const badRequeued = await insertJob({ orgId: B.orgId, documentId: dA3.id, status: 'queued', attempts: 0, updatedAgo: LOCK_MIN + 1 });
    const dA2Before = await doc(dA2.id);
    const dA3Before = await doc(dA3.id);

    await recoverStaleJobs();

    expect((await outboxFor(jA.id))[0].payload.organizationId).toBe(A.orgId);
    expect((await outboxFor(jB.id))[0].payload.organizationId).toBe(B.orgId);
    expect((await outboxFor(badRequeued.id))[0].payload.organizationId).toBe(B.orgId); // never A's
    expect((await job(badExhausted.id)).status).toBe('failed');
    expect(await doc(dA2.id)).toEqual(dA2Before); // org A's document untouched by org B's job

    // Under RLS, org A cannot see org B's recovered jobs
    const visibleToA = await withTenantTransaction(A.orgId, (c) =>
      c.query('SELECT id FROM document_processing_jobs').then(r => r.rows.map(x => x.id)));
    expect(visibleToA).toEqual(expect.arrayContaining([jA.id]));
    expect(visibleToA).not.toEqual(expect.arrayContaining([jB.id]));
    expect(visibleToA).not.toEqual(expect.arrayContaining([badRequeued.id]));

    // Processing the recovered cross-tenant event never touches org A's document
    jest.spyOn(rabbitmqService, 'publishDeadLetter').mockResolvedValue(true);
    try {
      const c = { ack: jest.fn(), nack: jest.fn(), retry: jest.fn() };
      await new DocumentProcessor('tenant-check').processJob((await outboxFor(badRequeued.id))[0].payload, c);
      expect(c.ack).toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
    expect((await job(badRequeued.id)).status).toBe('failed');
    expect(await doc(dA3.id)).toEqual(dA3Before);
  });
});

describe('Worker killed during embedding (real worker process)', () => {
  const sockets = [];
  let blackhole;
  let child;
  let worker;

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    sockets.forEach(s => s.destroy());
    if (blackhole) blackhole.close();
    if (worker) await worker.stop({ drainTimeoutMs: 5000 }).catch(() => {});
  });

  async function rowUnlocked(jobId) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '100ms'");
      await c.query('SELECT 1 FROM document_processing_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      return true;
    } catch (_) {
      return false;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  test('the abandoned job is recovered, both deliveries settle, and the document is processed exactly once', async () => {
    for (const q of [env.RABBITMQ_QUEUE, env.RABBITMQ_RETRY_QUEUE]) {
      if (!/test/i.test(q)) throw new Error(`Refusing to purge non-test queue "${q}"`);
    }
    await pool.query('TRUNCATE documents, document_processing_jobs, document_chunks, outbox_events, audit_logs CASCADE');
    await rabbitmqService.connect();
    await rabbitmqService.channel.purgeQueue(env.RABBITMQ_QUEUE);
    await rabbitmqService.channel.purgeQueue(env.RABBITMQ_RETRY_QUEUE);

    // An "Ollama" that accepts connections and never answers: the worker hangs in embedding
    blackhole = net.createServer((s) => {
      s.on('error', () => {}); // the killed worker resets the connection
      sockets.push(s);
    });
    await new Promise(r => blackhole.listen(0, '127.0.0.1', r));
    let childOutput = '';
    child = spawn(process.execPath, [path.join(BACKEND_DIR, 'src/worker.js')], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        OLLAMA_BASE_URL: `http://127.0.0.1:${blackhole.address().port}`,
        WORKER_METRICS_PORT: '0',
        JOB_RECOVERY_INTERVAL_MS: '3600000',
        OUTBOX_RELAY_INTERVAL_MS: '3600000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { childOutput += d; });
    child.stderr.on('data', (d) => { childOutput += d; });

    const pdf = await createTestPdf([
      'Recovery test page one: the quarterly revenue of the northern region grew by twelve percent.',
      'Recovery test page two: worker crash recovery requeues abandoned processing jobs safely.',
    ]);
    const res = await supertest(app).post('/api/documents')
      .set('Authorization', `Bearer ${A.users.admin.token}`).set('X-Organization-Id', A.orgId)
      .attach('file', pdf, 'recovery.pdf');
    expect(res.status).toBe(201);
    const { id: documentId, job: { id: jobId } } = res.body.data.document;

    await waitFor(() => sockets.length > 0, 60000, `worker to reach embedding. Worker output:\n${childOutput.slice(-2000)}`);
    child.kill('SIGKILL');
    await once(child, 'exit');

    // Postgres aborts the dead worker's transaction and releases its row lock
    await waitFor(() => rowUnlocked(jobId), 30000, 'dead worker transaction to be aborted');
    expect(await job(jobId)).toMatchObject({ status: 'processing', attempts: 1 });
    expect((await doc(documentId)).status).toBe('uploaded'); // the stuck state from the audit

    // The lock expires (simulated instead of waiting JOB_LOCK_TIMEOUT_MINUTES)
    await pool.query(
      'UPDATE document_processing_jobs SET locked_at = now() - make_interval(mins => $2::int) WHERE id = $1',
      [jobId, LOCK_MIN + 1]);
    const recovery = await recoverStaleJobs();
    expect(recovery.jobs.map(j => j.id)).toEqual([jobId]);
    expect(await relayPendingOutbox({ minAgeSeconds: 0 })).toBe(1);

    // A healthy worker now receives the recovery message (and the dead worker's redelivery)
    worker = new DocumentWorker({ workerId: 'recovery-e2e-worker' });
    await worker.start();
    await waitFor(async () => (await job(jobId)).status === 'completed', 120000, 'job completion');
    await waitFor(async () => worker.activeJobs === 0 && (await rabbitmqService.getQueueDepths()).main === 0,
      30000, 'all deliveries settled');
    await sleep(1000);

    const finalJob = await job(jobId);
    expect(finalJob.attempts).toBe(2); // dead attempt + recovered attempt
    expect((await doc(documentId)).status).toBe('ready');
    const { rows: done } = await pool.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DOCUMENT_PROCESSING_COMPLETED' AND resource_id = $1", [documentId]);
    expect(done[0].n).toBe(1); // duplicate delivery was not processed again

    // No duplicate embeddings: exactly one Qdrant point per chunk
    const { rows: chunks } = await pool.query(
      'SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [documentId]);
    const count = await qdrantService._request(`/collections/${env.QDRANT_COLLECTION}/points/count`, {
      method: 'POST',
      body: JSON.stringify({ exact: true, filter: { must: [{ key: 'document_id', match: { value: documentId } }] } }),
    });
    expect(chunks[0].n).toBeGreaterThan(0);
    expect(count.result.count).toBe(chunks[0].n);
  }, 240000);
});
