/**
 * Phase 3.3 WP5 (F2) — opt-in suite: the API under the REAL documind_api login (migration 012).
 *
 * documind_api is NOBYPASSRLS and holds no direct privilege on any tenant table; it may only
 * SET ROLE documind_app (tenant transactions). This suite loads an ISOLATED copy of the app whose
 * pool connects with API_ROLE_DATABASE_URL and proves: identity and attributes, SET ROLE limits,
 * that direct pool queries cannot read or write tenant data, transaction-local context reset,
 * cross-tenant isolation, the restricted SECURITY DEFINER routing function, and real API flows
 * (organization creation, member management, invitations, preview/accept, fire-and-forget
 * audits) working without BYPASSRLS.
 *
 * Opt-in: without API_ROLE_DATABASE_URL every test is skipped. The URL is supplied at run time
 * only (temporary local password, never in the repository), must name documind_api on
 * documind_test, and is never printed. Fixtures/cleanup use the test admin connection.
 */

const API_URL = process.env.API_ROLE_DATABASE_URL;
const SKIP_REASON = 'skipped: set API_ROLE_DATABASE_URL (documind_api on documind_test) to run';
const TENANT_TABLES = ['documents', 'document_chunks', 'document_processing_jobs', 'conversations', 'messages',
  'citations', 'audit_logs', 'organization_invitations'];

function checkApiUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('API_ROLE_DATABASE_URL is not a valid URL'); }
  if (decodeURIComponent(url.username) !== 'documind_api') throw new Error('API_ROLE_DATABASE_URL must use the documind_api login');
  if (url.pathname !== '/documind_test') throw new Error('API_ROLE_DATABASE_URL must target documind_test');
}

(API_URL ? describe : describe.skip)(`API as the real documind_api login (${API_URL ? 'enabled' : SKIP_REASON})`, () => {
  let api; // isolated app graph connected as documind_api
  let adminPool;
  let h;
  let helpers;
  let supertest;
  let orgA;
  let orgB;
  let invB;
  const codeOf = (p) => p.then(() => 'ok', e => e.code);

  beforeAll(async () => {
    checkApiUrl(API_URL);
    supertest = require('supertest');
    h = require('../streaming/stream.helpers');
    helpers = require('../security/invitation.helpers');
    adminPool = require('../../src/db').pool;
    expect((await adminPool.query('SELECT current_database() AS d')).rows[0].d).toBe('documind_test');

    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = API_URL;
    try {
      jest.isolateModules(() => {
        api = {
          env: require('../../src/config/env'),
          app: require('../../src/app'),
          pool: require('../../src/db').pool,
          withTenantTransaction: require('../../src/db/transaction').withTenantTransaction,
          invitationRepo: require('../../src/repositories/invitation.repository'),
          redis: require('../../src/middleware/rate-limiter').getRedisClient(),
        };
      });
    } finally {
      process.env.DATABASE_URL = previous;
    }
    const { rows: [who] } = await api.pool.query(
      "SELECT current_database() AS db, session_user AS su, current_user AS cu, current_setting('role') AS role");
    expect(who).toEqual({ db: 'documind_test', su: 'documind_api', cu: 'documind_api', role: 'none' });

    await h.truncateAll();
    await helpers.clearOrgRateLimits();
    orgA = await h.createOrgWithUsers('api-a', ['admin', 'member']);
    orgB = await h.createOrgWithUsers('api-b', ['admin']);
    invB = await helpers.seedInviteWithToken({ organization_id: orgB.orgId, email: 'api-invitee-b@documind.test', invited_by: orgB.users.admin.id });
    await adminPool.query(
      "INSERT INTO audit_logs (organization_id, actor_id, action) VALUES ($1, $2, 'API_ROLE_FIXTURE_B')", [orgB.orgId, orgB.users.admin.id]);
  });

  afterAll(async () => {
    if (h) { await h.truncateAll(); await helpers.clearOrgRateLimits(); }
    if (api) { await api.pool.end(); if (api.redis.isOpen) await api.redis.quit(); }
    if (adminPool) await adminPool.end();
  });

  test('1. attributes and role graph: no superuser, no BYPASSRLS, documind_app via SET only', async () => {
    const { rows: [r] } = await api.pool.query(
      "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = 'documind_api'");
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    const { rows } = await api.pool.query(
      `SELECT r.rolname, m.inherit_option, m.set_option, m.admin_option FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = 'documind_api'::regrole`);
    expect(rows).toEqual([{ rolname: 'documind_app', inherit_option: false, set_option: true, admin_option: false }]);
  });

  test('2. SET ROLE: only documind_app; admin, runtime and the router role are refused', async () => {
    const c = await api.pool.connect();
    try {
      for (const role of ['documind_admin', 'documind_runtime', 'documind_token_router', 'postgres']) {
        expect(await codeOf(c.query(`SET ROLE ${role}`))).toMatch(/^(42501|22023)$/);
      }
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE documind_app');
      expect((await c.query('SELECT current_user AS u')).rows[0].u).toBe('documind_app');
      await c.query('ROLLBACK');
      expect((await c.query('SELECT current_user AS u')).rows[0].u).toBe('documind_api');
    } finally {
      c.release();
    }
  });

  test('3. direct pool queries cannot read or write ANY tenant table (no privilege, no bypass)', async () => {
    for (const t of TENANT_TABLES) {
      expect([t, await codeOf(api.pool.query(`SELECT 1 FROM ${t} LIMIT 1`))]).toEqual([t, '42501']);
      expect([t, await codeOf(api.pool.query(`DELETE FROM ${t}`))]).toEqual([t, '42501']);
      expect([t, await codeOf(api.pool.query(`UPDATE ${t} SET organization_id = organization_id`))]).toEqual([t, '42501']);
    }
    expect(await codeOf(api.pool.query("INSERT INTO audit_logs (organization_id, actor_id, action) VALUES ($1, $2, 'X')",
      [orgB.orgId, orgB.users.admin.id]))).toBe('42501');
  });

  test('4. global tables: only the needed operations', async () => {
    expect(await codeOf(api.pool.query('SELECT id FROM users LIMIT 1'))).toBe('ok');
    for (const sql of ['DELETE FROM users', 'UPDATE users SET full_name = full_name', 'DELETE FROM organizations',
      'DELETE FROM memberships', 'TRUNCATE memberships', 'SELECT 1 FROM oauth_accounts', 'SELECT 1 FROM schema_migrations',
      'DELETE FROM outbox_events', 'INSERT INTO outbox_events DEFAULT VALUES', 'CREATE TABLE api_probe (x int)']) {
      expect([sql, await codeOf(api.pool.query(sql))]).toEqual([sql, '42501']);
    }
  });

  test('5. tenant context is transaction-local: reset after COMMIT and after ROLLBACK', async () => {
    let pid;
    await api.withTenantTransaction(orgA.orgId, async (c) => {
      const { rows: [s] } = await c.query("SELECT pg_backend_pid() AS pid, current_user AS u, current_setting($1, true) AS t", [api.env.PG_TENANT_SETTING]);
      expect(s).toMatchObject({ u: 'documind_app', t: orgA.orgId });
      pid = s.pid;
    });
    await expect(api.withTenantTransaction(orgA.orgId, async () => { throw new Error('rollback'); })).rejects.toThrow('rollback');
    const clients = [];
    try {
      for (let i = 0; i < api.pool.totalCount; i++) clients.push(await api.pool.connect());
      const states = await Promise.all(clients.map(c => c.query(
        "SELECT pg_backend_pid() AS pid, current_user AS u, coalesce(current_setting($1, true), '') AS t", [api.env.PG_TENANT_SETTING])));
      for (const { rows: [s] } of states) expect(s).toMatchObject({ u: 'documind_api', t: '' });
      expect(states.map(s => s.rows[0].pid)).toContain(pid);
    } finally {
      clients.forEach(c => c.release());
    }
  });

  test('6. inside tenant A, organization B is invisible and immutable', async () => {
    const r = await api.withTenantTransaction(orgA.orgId, async (c) => ({
      inv: (await c.query('SELECT count(*)::int AS n FROM organization_invitations WHERE organization_id = $1', [orgB.orgId])).rows[0].n,
      audit: (await c.query('SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1', [orgB.orgId])).rows[0].n,
      upd: (await c.query("UPDATE organization_invitations SET status = 'revoked' WHERE organization_id = $1", [orgB.orgId])).rowCount,
      del: (await c.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgB.orgId])).rowCount,
    }));
    expect(r).toEqual({ inv: 0, audit: 0, upd: 0, del: 0 });
    await expect(api.withTenantTransaction(orgA.orgId, c => c.query(
      "INSERT INTO audit_logs (organization_id, actor_id, action) VALUES ($1, $2, 'CROSS')", [orgB.orgId, orgA.users.admin.id])))
      .rejects.toMatchObject({ code: '42501' });
    expect((await adminPool.query("SELECT status FROM organization_invitations WHERE id = $1", [invB.row.id])).rows[0].status).toBe('pending');
    expect((await adminPool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('API_ROLE_FIXTURE_B')")).rows[0].n).toBe(1);
  });

  test('7. routing function: exact hash only, organization_id only, restricted definition', async () => {
    expect(await api.invitationRepo.findOrganizationIdByTokenHash(api.pool, invB.row.token_hash)).toBe(orgB.orgId);
    for (const bad of [invB.row.token_hash.toUpperCase(), invB.row.token_hash.slice(0, 63), `${invB.row.token_hash.slice(0, 60)}%`, "' OR '1'='1", '']) {
      expect(await api.invitationRepo.findOrganizationIdByTokenHash(api.pool, bad)).toBeNull();
    }
    const { rows: [f] } = await adminPool.query(
      `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text[] AS acl,
              pg_get_function_result(p.oid) AS result
       FROM pg_proc p WHERE p.oid = 'public.invitation_organization_for_token_hash(text)'::regprocedure`);
    expect(f).toMatchObject({ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'], owner: 'documind_token_router', result: 'uuid' });
    expect(f.acl.map(a => a.split('=')[0]).filter(Boolean).sort()).toEqual(['documind_api', 'documind_runtime', 'documind_token_router']);
    const { rows: [o] } = await adminPool.query(
      "SELECT rolcanlogin, rolbypassrls, rolsuper, (SELECT count(*)::int FROM pg_auth_members WHERE roleid = r.oid) AS members FROM pg_roles r WHERE rolname = 'documind_token_router'");
    expect(o).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false, members: 0 });
  });

  test('8. real API flows work without BYPASSRLS; audits land in the right tenant', async () => {
    const as = (token) => ({
      post: (url) => supertest(api.app).post(url).set('Authorization', `Bearer ${token}`),
      get: (url) => supertest(api.app).get(url).set('Authorization', `Bearer ${token}`),
    });
    // organization creation (ORG_CREATE written in the new tenant's context)
    const created = await as(orgA.users.admin.token).post('/api/organizations').send({ name: 'Api Created', slug: 'api-created' });
    expect(created.status).toBe(201);
    const newOrgId = created.body.data.org.id;
    // member management (MEMBER_ADD via the fire-and-forget audit path → own tenant transaction)
    const added = await as(orgA.users.admin.token).post(`/api/organizations/${orgA.orgId}/members`).send({ email: 'api-b_admin@documind.test', role: 'viewer' });
    expect(added.status).toBeLessThan(300);
    expect((await as(orgA.users.admin.token).get(`/api/organizations/${orgA.orgId}/members`)).status).toBe(200);
    // invitation create → preview → accept, as documind_api end to end
    const invitee = await helpers.createUser('api-invitee-a@documind.test');
    const inv = await as(orgA.users.admin.token).post(`/api/organizations/${orgA.orgId}/invitations`).send({ email: invitee.email, role: 'member' });
    expect(inv.status).toBe(201);
    expect((await as(invitee.token).post('/api/invitations/preview').send({ token: inv.body.data.token })).status).toBe(200);
    expect((await as(invitee.token).post('/api/invitations/accept').send({ token: inv.body.data.token })).status).toBe(200);
    expect((await as(invitee.token).post('/api/invitations/accept').send({ token: inv.body.data.token })).status).toBe(404);

    const audits = (await adminPool.query(
      'SELECT organization_id, action FROM audit_logs WHERE action = ANY($1) ORDER BY created_at',
      [['ORG_CREATE', 'MEMBER_ADD', 'INVITATION_CREATE', 'INVITATION_ACCEPT']])).rows;
    expect(audits).toEqual(expect.arrayContaining([
      { organization_id: newOrgId, action: 'ORG_CREATE' },
      { organization_id: orgA.orgId, action: 'MEMBER_ADD' },
      { organization_id: orgA.orgId, action: 'INVITATION_CREATE' },
      { organization_id: orgA.orgId, action: 'INVITATION_ACCEPT' },
    ]));
    expect(audits.filter(a => a.organization_id === orgB.orgId)).toEqual([]);
    expect((await adminPool.query('SELECT role, status FROM memberships WHERE organization_id = $1 AND user_id = $2', [orgA.orgId, invitee.id])).rows)
      .toEqual([{ role: 'member', status: 'active' }]);
  });
});
