/**
 * Phase 3.4 (F2, Option A) — worker database architecture under the regular test login.
 *
 * Covers what does not need a real documind_worker login (that is the opt-in suite):
 *  - migration 013 ledger, role catalog, discovery-function definition, policy and EXECUTE grants;
 *  - discovery function output, input clamping and staleness rule;
 *  - recovery is atomic PER JOB (a failing job rolls back alone; earlier jobs stay committed);
 *  - the permanent-failure path writes job, document and audit in ONE tenant transaction;
 *  - pooled connections carry no role or tenant after success or failure;
 *  - worker connection selection (WORKER_DATABASE_URL only for the worker process).
 * Real PostgreSQL (documind_test); external services are stubbed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../../src/config/env');
const { pool, connectionStringFor } = require('../../src/db');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const qdrantService = require('../../src/vector/qdrant.service');
const outboxRepo = require('../../src/repositories/outbox.repository');
const auditRepo = require('../../src/repositories/audit.repository');
const docRepo = require('../../src/repositories/document.repository');
const { recoverStaleJobs } = require('../../src/workers/job-recovery');
const DocumentProcessor = require('../../src/workers/processor');
const h = require('../streaming/stream.helpers');

const FN = 'public.worker_stale_job_candidates(integer, integer)';
const LOCK_MIN = env.JOB_LOCK_TIMEOUT_MINUTES;
let A;
let B;

async function insertDoc(org, status = 'processing') {
  const { rows } = await pool.query(
    `INSERT INTO documents (organization_id, uploaded_by, filename, original_name, mime_type, file_size, storage_key, status)
     VALUES ($1, $2, 'f.pdf', 'f.pdf', 'application/pdf', 10, 'k', $3) RETURNING *`,
    [org.orgId, org.users.admin.id, status]);
  return rows[0];
}
async function insertJob({ org, documentId, status, attempts = 1, lockedAgo = null, updatedAgo = 0 }) {
  const { rows } = await pool.query(
    `INSERT INTO document_processing_jobs (organization_id, document_id, stage, status, attempts, max_attempts, worker_id, locked_at, updated_at, created_at)
     VALUES ($1, $2, 'embedding', $3::varchar, $4, 3, CASE WHEN $3::varchar = 'processing' THEN 'dead-worker' END,
       CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END,
       now() - make_interval(mins => $6::int), now() - make_interval(mins => $6::int))
     RETURNING *`, [org.orgId, documentId, status, attempts, lockedAgo, updatedAgo]);
  return rows[0];
}
const jobRow = async id => (await pool.query('SELECT status, worker_id, attempts FROM document_processing_jobs WHERE id = $1', [id])).rows[0];
const auditsFor = async docId => (await pool.query('SELECT organization_id, action FROM audit_logs WHERE resource_id = $1 ORDER BY created_at', [docId])).rows;
const outboxFor = async jobId => (await pool.query("SELECT organization_id FROM outbox_events WHERE payload->>'jobId' = $1", [jobId])).rows;

async function pooledStates() {
  const clients = [];
  try {
    for (let i = 0; i < pool.totalCount; i++) clients.push(await pool.connect());
    return await Promise.all(clients.map(async c => (await c.query(
      "SELECT current_user = session_user AS same_role, coalesce(current_setting($1, true), '') AS tenant", [env.PG_TENANT_SETTING])).rows[0]));
  } finally {
    clients.forEach(c => c.release());
  }
}

beforeAll(async () => {
  expect((await pool.query('SELECT current_database() AS d')).rows[0].d).toBe('documind_test');
  await h.truncateAll();
  A = await h.createOrgWithUsers('wdb-a', ['admin']);
  B = await h.createOrgWithUsers('wdb-b', ['admin']);
});
beforeEach(async () => {
  await pool.query('TRUNCATE documents, document_processing_jobs, document_chunks, outbox_events, audit_logs CASCADE');
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await h.truncateAll();
  await pool.end();
});

describe('migration 013: catalog', () => {
  test('applied once with the checksum of the file on disk', async () => {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../migrations/013_worker_role.sql'), 'utf8')).digest('hex');
    expect((await pool.query("SELECT checksum FROM schema_migrations WHERE filename = '013_worker_role.sql'")).rows).toEqual([{ checksum: sum }]);
  });

  test('documind_worker: LOGIN, NOINHERIT, no superuser/BYPASSRLS/createdb/createrole; only SET documind_app', async () => {
    const { rows: [r] } = await pool.query(
      "SELECT rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = 'documind_worker'");
    expect(r).toEqual({ rolcanlogin: true, rolinherit: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, no_password: true });
    const { rows } = await pool.query(
      `SELECT r.rolname, m.inherit_option, m.set_option, m.admin_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
       WHERE m.member = 'documind_worker'::regrole`);
    expect(rows).toEqual([{ rolname: 'documind_app', inherit_option: false, set_option: true, admin_option: false }]);
  });

  test('documind_worker direct privileges: SELECT and UPDATE on outbox_events only', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
       WHERE grantee = 'documind_worker' AND table_schema = 'public' GROUP BY table_name`);
    expect(rows).toEqual([{ table_name: 'outbox_events', p: 'SELECT,UPDATE' }]);
    const { rows: [cols] } = await pool.query("SELECT count(*)::int AS n FROM information_schema.column_privileges WHERE grantee = 'documind_worker'");
    expect(cols.n).toBeGreaterThan(0); // table grants imply column entries; checked below that none exist elsewhere
    const { rows: elsewhere } = await pool.query(
      "SELECT DISTINCT table_name FROM information_schema.column_privileges WHERE grantee = 'documind_worker' AND table_name <> 'outbox_events'");
    expect(elsewhere).toEqual([]);
  });

  test('documind_worker_router: NOLOGIN, no members, reads exactly five job columns via a SELECT-only policy', async () => {
    const { rows: [r] } = await pool.query(
      "SELECT rolcanlogin, rolsuper, rolbypassrls, (SELECT count(*)::int FROM pg_auth_members WHERE roleid = 'documind_worker_router'::regrole) AS members FROM pg_roles WHERE rolname = 'documind_worker_router'");
    expect(r).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, members: 0 });
    const { rows: cols } = await pool.query(
      `SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
       WHERE grantee = 'documind_worker_router' ORDER BY column_name`);
    expect(cols.map(c => [c.table_name, c.column_name, c.privilege_type])).toEqual(
      ['id', 'locked_at', 'organization_id', 'status', 'updated_at'].map(c => ['document_processing_jobs', c, 'SELECT']));
    const { rows: pol } = await pool.query(
      "SELECT policyname, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE tablename = 'document_processing_jobs' ORDER BY policyname");
    expect(pol.map(p => p.policyname)).toEqual(['tenant_isolation_doc_jobs', 'worker_router_stale_scan']);
    expect(pol[1]).toEqual({ policyname: 'worker_router_stale_scan', roles: ['documind_worker_router'], cmd: 'SELECT', qual: 'true', with_check: null });
  });

  test('014 (forward correction) applied once with the checksum of the file on disk', async () => {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../migrations/014_worker_fn_execute_worker_only.sql'), 'utf8')).digest('hex');
    expect((await pool.query("SELECT checksum FROM schema_migrations WHERE filename = '014_worker_fn_execute_worker_only.sql'")).rows).toEqual([{ checksum: sum }]);
  });

  test('discovery function: SECURITY DEFINER, STABLE, STRICT, fixed search_path, owner router, EXECUTE documind_worker only', async () => {
    const { rows: [f] } = await pool.query(
      `SELECT prosecdef, provolatile, proisstrict, proconfig, pg_get_userbyid(proowner) AS owner, pg_get_function_result(oid) AS result
       FROM pg_proc WHERE oid = '${FN}'::regprocedure`);
    expect(f).toEqual({ prosecdef: true, provolatile: 's', proisstrict: true, proconfig: ['search_path=pg_catalog, pg_temp'],
      owner: 'documind_worker_router', result: 'TABLE(job_id uuid, organization_id uuid)' });
    const roles = ['documind_worker', 'documind_runtime', 'documind_api', 'documind_app', 'documind_token_router'];
    const { rows } = await pool.query(
      `SELECT r, has_function_privilege(r, '${FN}', 'EXECUTE') AS x FROM unnest($1::text[]) AS r`, [roles]);
    expect(Object.fromEntries(rows.map(x => [x.r, x.x]))).toEqual({
      documind_worker: true, documind_runtime: false, documind_api: false, documind_app: false, documind_token_router: false,
    });
    // Exact ACL: owner + documind_worker; no PUBLIC (grantee 0) entry, no runtime
    const { rows: acl } = await pool.query(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee, a.privilege_type
       FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${FN}'::regprocedure ORDER BY 1`);
    expect(acl).toEqual([
      { grantee: 'documind_worker', privilege_type: 'EXECUTE' },
      { grantee: 'documind_worker_router', privilege_type: 'EXECUTE' },
    ]);
  });

  test('API and token-router roles are unchanged by 013', async () => {
    const { rows } = await pool.query(
      "SELECT rolname, rolbypassrls, rolcanlogin, rolinherit FROM pg_roles WHERE rolname IN ('documind_api', 'documind_token_router') ORDER BY 1");
    expect(rows).toEqual([
      { rolname: 'documind_api', rolbypassrls: false, rolcanlogin: true, rolinherit: true },
      { rolname: 'documind_token_router', rolbypassrls: false, rolcanlogin: false, rolinherit: false },
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member = 'documind_api'::regrole")).rows[0].n).toBe(1);
  });
});

describe('discovery function behaviour', () => {
  test('lists exactly the stale jobs (same rule as recovery), oldest first, ids only', async () => {
    const d = await Promise.all([A, A, B, A, A].map(o => insertDoc(o)));
    const expiredA = await insertJob({ org: A, documentId: d[0].id, status: 'processing', lockedAgo: LOCK_MIN + 5, updatedAgo: LOCK_MIN + 5 });
    const lostB = await insertJob({ org: B, documentId: d[2].id, status: 'queued', updatedAgo: LOCK_MIN + 50 });
    await insertJob({ org: A, documentId: d[1].id, status: 'processing', lockedAgo: 1, updatedAgo: 1 }); // live lock
    await insertJob({ org: A, documentId: d[3].id, status: 'completed', updatedAgo: LOCK_MIN + 99 }); // terminal
    await insertJob({ org: A, documentId: d[4].id, status: 'retrying', updatedAgo: 1 }); // recent
    const { rows, fields } = await pool.query('SELECT * FROM public.worker_stale_job_candidates($1, $2)', [LOCK_MIN, 50]);
    expect(fields.map(f => f.name)).toEqual(['job_id', 'organization_id']);
    expect(rows).toEqual([
      { job_id: lostB.id, organization_id: B.orgId },
      { job_id: expiredA.id, organization_id: A.orgId },
    ]);
  });

  test('inputs are clamped (limit 1..500, timeout >= 1 minute) and NULL returns nothing', async () => {
    const docs = await Promise.all([A, A, B].map(o => insertDoc(o)));
    for (const dd of docs) await insertJob({ org: A.orgId === dd.organization_id ? A : B, documentId: dd.id, status: 'queued', updatedAgo: 5 });
    const count = async (t, l) => (await pool.query('SELECT count(*)::int AS n FROM public.worker_stale_job_candidates($1, $2)', [t, l])).rows[0].n;
    expect(await count(1, 0)).toBe(1);
    expect(await count(1, -10)).toBe(1);
    expect(await count(1, 100000)).toBe(3);
    expect(await count(-100, 10)).toBe(3); // clamped to 1 minute: 5-minute-old jobs are stale
    expect(await count(10, 10)).toBe(0);
    expect(await count(null, 10)).toBe(0);
    expect(await count(1, null)).toBe(0);
  });
});

describe('recovery: atomic per job, each in its own tenant', () => {
  test('a failing job rolls back alone; the job before it stays committed; the next sweep recovers it', async () => {
    const dA = await insertDoc(A);
    const dB = await insertDoc(B);
    const jA = await insertJob({ org: A, documentId: dA.id, status: 'processing', lockedAgo: LOCK_MIN + 20, updatedAgo: LOCK_MIN + 20 }); // older → first
    const jB = await insertJob({ org: B, documentId: dB.id, status: 'processing', lockedAgo: LOCK_MIN + 10, updatedAgo: LOCK_MIN + 10 });

    const real = outboxRepo.createEvent;
    jest.spyOn(outboxRepo, 'createEvent').mockImplementation((client, e) => (
      e.payload.jobId === jB.id ? Promise.reject(new Error('outbox insert failed')) : real(client, e)));
    await expect(recoverStaleJobs()).rejects.toThrow('outbox insert failed');

    expect((await jobRow(jA.id)).status).toBe('retrying');
    expect(await outboxFor(jA.id)).toEqual([{ organization_id: A.orgId }]);
    expect(await auditsFor(dA.id)).toEqual([{ organization_id: A.orgId, action: 'DOCUMENT_PROCESSING_RECOVERED' }]);
    // job B: untouched — no status change, no outbox event, no audit
    expect(await jobRow(jB.id)).toEqual({ status: 'processing', worker_id: 'dead-worker', attempts: 1 });
    expect(await outboxFor(jB.id)).toEqual([]);
    expect(await auditsFor(dB.id)).toEqual([]);

    jest.restoreAllMocks();
    const second = await recoverStaleJobs();
    expect(second.jobs.map(j => j.id)).toEqual([jB.id]);
    expect(await outboxFor(jB.id)).toEqual([{ organization_id: B.orgId }]);
    expect(await auditsFor(dB.id)).toEqual([{ organization_id: B.orgId, action: 'DOCUMENT_PROCESSING_RECOVERED' }]);
    expect(await pooledStates()).toEqual(Array(pool.totalCount).fill({ same_role: true, tenant: '' }));
  });

  test('a job claimed between discovery and its tenant transaction is skipped (re-check under lock)', async () => {
    const dA = await insertDoc(A);
    const jA = await insertJob({ org: A, documentId: dA.id, status: 'processing', lockedAgo: LOCK_MIN + 5, updatedAgo: LOCK_MIN + 5 });
    const real = pool.query.bind(pool);
    jest.spyOn(pool, 'query').mockImplementation(async (...args) => {
      const res = await real(...args);
      if (typeof args[0] === 'string' && args[0].includes('worker_stale_job_candidates')) {
        // a live worker re-claims the job right after discovery
        await real("UPDATE document_processing_jobs SET locked_at = now(), worker_id = 'live' WHERE id = $1", [jA.id]);
      }
      return res;
    });
    const result = await recoverStaleJobs();
    expect(result.jobs).toEqual([]);
    expect(await jobRow(jA.id)).toEqual({ status: 'processing', worker_id: 'live', attempts: 1 });
    expect(await outboxFor(jA.id)).toEqual([]);
  });
});

describe('processor permanent failure: job, document and audit in one tenant transaction', () => {
  async function failingRun({ breakAudit }) {
    const d = await insertDoc(A, 'uploaded');
    const j = await insertJob({ org: A, documentId: d.id, status: 'queued', attempts: 0 });
    jest.spyOn(docRepo, 'findById').mockResolvedValue(null); // → "not found": permanent failure
    jest.spyOn(qdrantService, 'deleteByDocument').mockResolvedValue();
    const dlq = jest.spyOn(rabbitmqService, 'publishDeadLetter').mockResolvedValue(true);
    if (breakAudit) {
      const realLog = auditRepo.log.bind(auditRepo);
      jest.spyOn(auditRepo, 'log').mockImplementation((entry, client) => (
        entry.action === 'DOCUMENT_PROCESSING_FAILED' ? Promise.reject(new Error('audit insert failed')) : realLog(entry, client)));
    }
    const ack = jest.fn();
    await new DocumentProcessor('wdb-test').processJob(
      { event: 'document.process', jobId: j.id, documentId: d.id, organizationId: A.orgId }, { ack, nack: jest.fn(), retry: jest.fn() });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveBeenCalledTimes(1);
    return { d, j };
  }

  test('all three commit together, in the job organization', async () => {
    const { d, j } = await failingRun({ breakAudit: false });
    expect((await jobRow(j.id)).status).toBe('failed');
    expect((await pool.query('SELECT status FROM documents WHERE id = $1', [d.id])).rows[0].status).toBe('failed');
    expect(await auditsFor(d.id)).toEqual([{ organization_id: A.orgId, action: 'DOCUMENT_PROCESSING_FAILED' }]);
    expect(await pooledStates()).toEqual(Array(pool.totalCount).fill({ same_role: true, tenant: '' }));
  });

  test('if the audit insert fails, job and document roll back with it (still dead-lettered)', async () => {
    const { d, j } = await failingRun({ breakAudit: true });
    expect((await jobRow(j.id)).status).toBe('processing'); // claimed; stale-job recovery settles it later
    expect((await pool.query('SELECT status FROM documents WHERE id = $1', [d.id])).rows[0].status).toBe('uploaded');
    expect(await auditsFor(d.id)).toEqual([]);
    expect(await pooledStates()).toEqual(Array(pool.totalCount).fill({ same_role: true, tenant: '' }));
  });
});

describe('worker connection selection', () => {
  const cfg = { DATABASE_URL: 'postgres://api@db/x', WORKER_DATABASE_URL: 'postgres://worker@db/x' };
  test.each([
    ['worker', cfg, cfg.WORKER_DATABASE_URL],
    ['worker', { DATABASE_URL: cfg.DATABASE_URL }, cfg.DATABASE_URL], // unset → unchanged behaviour
    [undefined, cfg, cfg.DATABASE_URL], // the API never uses the worker login
    ['api', cfg, cfg.DATABASE_URL],
  ])('process role %p', (role, config, expected) => {
    expect(connectionStringFor(role, config)).toBe(expected);
  });
});
