/**
 * Phase 3.4 (F2, Option A) — opt-in suite: the worker under the REAL documind_worker login (013).
 *
 * documind_worker is NOBYPASSRLS, NOINHERIT and holds direct privileges only on outbox_events and
 * EXECUTE on worker_stale_job_candidates(); tenant work happens only inside SET LOCAL ROLE
 * documind_app. This suite loads an ISOLATED copy of the worker modules whose pool connects with
 * WORKER_DATABASE_URL (selected through DOCUMIND_PROCESS_ROLE=worker, as src/worker.js does) and
 * proves: identity and attributes, SET ROLE limits, no direct tenant-table access, the discovery
 * function, tenant-scoped job lookup (cross-tenant job ids are invisible), spoofed queue
 * organizations dead-lettered, recovery end-to-end without BYPASSRLS, and role/tenant reset of
 * pooled connections after success and failure.
 *
 * Opt-in: without WORKER_ROLE_DATABASE_URL every test is skipped. The URL is supplied at run time
 * only (temporary local password, never in the repository), must name documind_worker on
 * documind_test, and is never printed. Fixtures/cleanup use the test admin connection.
 */

const WORKER_URL = process.env.WORKER_ROLE_DATABASE_URL;
const SKIP_REASON = 'skipped: set WORKER_ROLE_DATABASE_URL (documind_worker on documind_test) to run';
const TENANT_TABLES = ['documents', 'document_chunks', 'document_processing_jobs', 'conversations', 'messages',
  'citations', 'audit_logs', 'organization_invitations'];
const OTHER_TABLES = ['users', 'organizations', 'memberships', 'oauth_accounts', 'schema_migrations'];

function checkWorkerUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('WORKER_ROLE_DATABASE_URL is not a valid URL'); }
  if (decodeURIComponent(url.username) !== 'documind_worker') throw new Error('WORKER_ROLE_DATABASE_URL must use the documind_worker login');
  if (url.pathname !== '/documind_test') throw new Error('WORKER_ROLE_DATABASE_URL must target documind_test');
}

(WORKER_URL ? describe : describe.skip)(`worker as the real documind_worker login (${WORKER_URL ? 'enabled' : SKIP_REASON})`, () => {
  let w; // isolated worker module graph connected as documind_worker
  let adminPool;
  let h;
  let A;
  let B;
  const codeOf = (p) => p.then(() => 'ok', e => e.code);

  async function insertDocAndJob(org, { status = 'queued', ageMin = 0 } = {}) {
    const { rows: [d] } = await adminPool.query(
      `INSERT INTO documents (organization_id, uploaded_by, filename, original_name, mime_type, file_size, storage_key, status)
       VALUES ($1, $2, 'f.pdf', 'f.pdf', 'application/pdf', 10, 'k', 'uploaded') RETURNING id`, [org.orgId, org.users.admin.id]);
    const { rows: [j] } = await adminPool.query(
      `INSERT INTO document_processing_jobs (organization_id, document_id, stage, status, attempts, max_attempts, updated_at, created_at)
       VALUES ($1, $2, 'queued', $3, 1, 3, now() - make_interval(mins => $4::int), now() - make_interval(mins => $4::int)) RETURNING id`,
      [org.orgId, d.id, status, ageMin]);
    return { documentId: d.id, jobId: j.id };
  }

  async function pooledStates() {
    const clients = [];
    try {
      for (let i = 0; i < w.pool.totalCount; i++) clients.push(await w.pool.connect());
      return await Promise.all(clients.map(async c => (await c.query(
        "SELECT current_user AS cu, coalesce(current_setting($1, true), '') AS tenant", [w.env.PG_TENANT_SETTING])).rows[0]));
    } finally {
      clients.forEach(c => c.release());
    }
  }

  beforeAll(async () => {
    checkWorkerUrl(WORKER_URL);
    h = require('../streaming/stream.helpers');
    adminPool = require('../../src/db').pool;
    expect((await adminPool.query('SELECT current_database() AS d')).rows[0].d).toBe('documind_test');

    const saved = { role: process.env.DOCUMIND_PROCESS_ROLE, url: process.env.WORKER_DATABASE_URL };
    process.env.DOCUMIND_PROCESS_ROLE = 'worker';
    process.env.WORKER_DATABASE_URL = WORKER_URL;
    try {
      jest.isolateModules(() => {
        w = {
          env: require('../../src/config/env'),
          pool: require('../../src/db').pool,
          withTenantTransaction: require('../../src/db/transaction').withTenantTransaction,
          jobRepo: require('../../src/repositories/job.repository'),
          rabbitmq: require('../../src/queue/rabbitmq.service'),
          recoverStaleJobs: require('../../src/workers/job-recovery').recoverStaleJobs,
          DocumentProcessor: require('../../src/workers/processor'),
        };
      });
    } finally {
      if (saved.role === undefined) delete process.env.DOCUMIND_PROCESS_ROLE; else process.env.DOCUMIND_PROCESS_ROLE = saved.role;
      if (saved.url === undefined) delete process.env.WORKER_DATABASE_URL; else process.env.WORKER_DATABASE_URL = saved.url;
    }

    await h.truncateAll();
    A = await h.createOrgWithUsers('wrole-a', ['admin']);
    B = await h.createOrgWithUsers('wrole-b', ['admin']);
  });

  afterAll(async () => {
    if (w) await w.pool.end();
    if (h) await h.truncateAll();
    if (adminPool) await adminPool.end();
  });

  test('the pool is the documind_worker login with least-privilege attributes', async () => {
    const { rows: [r] } = await w.pool.query(
      `SELECT session_user AS su, current_user AS cu, current_database() AS db, rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = session_user`);
    expect(r).toEqual({ su: 'documind_worker', cu: 'documind_worker', db: 'documind_test',
      rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreatedb: false, rolcreaterole: false });
  });

  test('SET ROLE is limited to documind_app', async () => {
    const client = await w.pool.connect();
    try {
      for (const role of ['documind_admin', 'documind_runtime', 'documind_api', 'documind_worker_router', 'documind_token_router']) {
        expect([role, await codeOf(client.query(`SET ROLE ${role}`))]).toEqual([role, '42501']);
      }
      expect(await codeOf(client.query('SET ROLE documind_app'))).toBe('ok');
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      client.release();
    }
  });

  test('no direct access to tenant or identity tables; outbox read/update only', async () => {
    for (const t of [...TENANT_TABLES, ...OTHER_TABLES]) {
      expect([t, await codeOf(w.pool.query(`SELECT 1 FROM ${t} LIMIT 1`))]).toEqual([t, '42501']);
    }
    expect(await codeOf(w.pool.query('SELECT 1 FROM outbox_events LIMIT 1'))).toBe('ok');
    expect(await codeOf(w.pool.query('DELETE FROM outbox_events'))).toBe('42501');
    expect(await codeOf(w.pool.query("SELECT public.invitation_organization_for_token_hash(repeat('a', 64))"))).toBe('42501');
  });

  test('discovery function returns ids only and cannot be used to read job details', async () => {
    const stale = await insertDocAndJob(B, { ageMin: w.env.JOB_LOCK_TIMEOUT_MINUTES + 10 });
    const { rows, fields } = await w.pool.query('SELECT * FROM public.worker_stale_job_candidates($1, $2)', [w.env.JOB_LOCK_TIMEOUT_MINUTES, 50]);
    expect(fields.map(f => f.name)).toEqual(['job_id', 'organization_id']);
    expect(rows).toContainEqual({ job_id: stale.jobId, organization_id: B.orgId });
    expect(await codeOf(w.pool.query('SELECT error_log FROM document_processing_jobs'))).toBe('42501');
  });

  test('job lookup is tenant-scoped: another organization\'s job id is invisible', async () => {
    const jobB = await insertDocAndJob(B);
    expect(await w.withTenantTransaction(A.orgId, c => w.jobRepo.findById(c, jobB.jobId))).toBeFalsy();
    expect((await w.withTenantTransaction(B.orgId, c => w.jobRepo.findById(c, jobB.jobId))).organization_id).toBe(B.orgId);
    const upd = await w.withTenantTransaction(A.orgId, c => c.query("UPDATE document_processing_jobs SET status = 'failed' WHERE id = $1", [jobB.jobId]));
    expect(upd.rowCount).toBe(0);
    await expect(w.withTenantTransaction(A.orgId, c => c.query(
      "INSERT INTO audit_logs (organization_id, action) VALUES ($1, 'X')", [B.orgId]))).rejects.toMatchObject({ code: '42501' });
  });

  test('a spoofed queue organization is dead-lettered and leaves the job untouched', async () => {
    const jobB = await insertDocAndJob(B);
    const dlq = jest.spyOn(w.rabbitmq, 'publishDeadLetter').mockResolvedValue(true);
    const ack = jest.fn();
    const payload = { event: 'document.process', jobId: jobB.jobId, documentId: jobB.documentId, organizationId: A.orgId };
    await new w.DocumentProcessor('wrole').processJob(payload, { ack, nack: jest.fn(), retry: jest.fn() });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveBeenCalledWith(payload, 'Job record not found in PostgreSQL');
    dlq.mockRestore();
    const { rows: [j] } = await adminPool.query('SELECT status, worker_id FROM document_processing_jobs WHERE id = $1', [jobB.jobId]);
    expect(j).toEqual({ status: 'queued', worker_id: null });
  });

  test('stale-job recovery works end-to-end without BYPASSRLS, in each job\'s tenant', async () => {
    await adminPool.query('TRUNCATE document_processing_jobs, outbox_events, audit_logs CASCADE');
    const old = w.env.JOB_LOCK_TIMEOUT_MINUTES + 10;
    const ja = await insertDocAndJob(A, { ageMin: old });
    const jb = await insertDocAndJob(B, { ageMin: old });
    const result = await w.recoverStaleJobs();
    expect(result.jobs.map(j => j.id).sort()).toEqual([ja.jobId, jb.jobId].sort());
    const { rows } = await adminPool.query(
      "SELECT payload->>'jobId' AS job, organization_id FROM outbox_events ORDER BY 1");
    expect(rows).toEqual([{ job: ja.jobId, organization_id: A.orgId }, { job: jb.jobId, organization_id: B.orgId }]
      .sort((x, y) => x.job.localeCompare(y.job)));
    const { rows: audits } = await adminPool.query("SELECT organization_id FROM audit_logs WHERE action = 'DOCUMENT_PROCESSING_RECOVERED' ORDER BY 1");
    expect(audits.map(a => a.organization_id).sort()).toEqual([A.orgId, B.orgId].sort());
  });

  test('pooled connections carry no role or tenant after success and after failure', async () => {
    await w.withTenantTransaction(A.orgId, c => c.query('SELECT 1'));
    await expect(w.withTenantTransaction(A.orgId, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(w.withTenantTransaction(A.orgId, c => c.query('SELECT * FROM no_such_table'))).rejects.toMatchObject({ code: '42P01' });
    const states = await pooledStates();
    expect(states.length).toBeGreaterThan(0);
    expect(states).toEqual(Array(states.length).fill({ cu: 'documind_worker', tenant: '' }));
  });
});
