/**
 * F9 (P1) — opt-in suite: invitation security under the REAL runtime login (documind_runtime).
 *
 * Every other backend suite connects as the test admin login; code inside tenant transactions
 * drops to documind_app, but anything outside them (and any missing runtime grant) is never
 * exercised as the production login. This suite loads an ISOLATED copy of the app whose pool
 * connects with RUNTIME_ROLE_DATABASE_URL, and checks identity, transaction context reset,
 * cross-tenant isolation and real preview/accept requests.
 *
 * Opt-in: without RUNTIME_ROLE_DATABASE_URL every test is skipped and nothing is touched.
 * The URL is supplied at run time only (no credential in the repository) and must name the
 * documind_runtime user on the documind_test database; it is never printed. Fixtures and
 * cleanup use the regular test connection (DATABASE_URL, guarded to *_test), because the
 * runtime role has no TRUNCATE privilege.
 *
 *   RUNTIME_ROLE_DATABASE_URL=postgres://documind_runtime:<pw>@host:port/documind_test \
 *   DATABASE_URL=.../documind_test REDIS_URL=redis://127.0.0.1:6380/15 \
 *   npx jest --runInBand tests/runtime_role
 */

const RT_URL = process.env.RUNTIME_ROLE_DATABASE_URL;
const SKIP_REASON = 'skipped: set RUNTIME_ROLE_DATABASE_URL (documind_runtime on documind_test) to run';

/** Validate the URL's target without ever printing it. */
function checkRuntimeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('RUNTIME_ROLE_DATABASE_URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('RUNTIME_ROLE_DATABASE_URL must be a postgres:// URL');
  if (decodeURIComponent(url.username) !== 'documind_runtime') throw new Error('RUNTIME_ROLE_DATABASE_URL must use the documind_runtime login');
  if (url.pathname !== '/documind_test') throw new Error('RUNTIME_ROLE_DATABASE_URL must target the documind_test database');
}

(RT_URL ? describe : describe.skip)(`invitation security as the real runtime login (${RT_URL ? 'enabled' : SKIP_REASON})`, () => {
  const CTX_SQL = `SELECT pg_backend_pid() AS pid, session_user AS session_user, current_user AS current_user,
    current_setting('role') AS role, coalesce(current_setting($1, true), '') AS tenant`;
  let rt; // the isolated app, connected as documind_runtime
  let adminPool;
  let h;
  let helpers;
  let supertest;
  let orgA;
  let orgB;
  let invA;
  let invB;

  /** Find the runtime pool connection with backend `pid` and read its session state. */
  async function stateOfPooledBackend(pid) {
    const clients = [];
    try {
      for (let i = 0; i < rt.pool.totalCount; i += 1) clients.push(await rt.pool.connect());
      for (const c of clients) {
        const { rows: [s] } = await c.query(CTX_SQL, [rt.env.PG_TENANT_SETTING]);
        if (s.pid === pid) return s;
      }
      return null;
    } finally {
      clients.forEach(c => c.release());
    }
  }

  beforeAll(async () => {
    checkRuntimeUrl(RT_URL);
    supertest = require('supertest');
    h = require('../streaming/stream.helpers');
    helpers = require('../security/invitation.helpers');
    adminPool = require('../../src/db').pool;
    const { rows: [db] } = await adminPool.query('SELECT current_database() AS name');
    expect(db.name).toBe('documind_test');

    // Load a separate module graph whose env.js/db see the runtime URL.
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = RT_URL;
    try {
      jest.isolateModules(() => {
        rt = {
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

    // Fail fast: everything below is meaningless unless this really is the runtime login.
    const { rows: [who] } = await rt.pool.query(
      "SELECT current_database() AS db, session_user AS session_user, current_setting('role') AS role",
    );
    expect(who).toEqual({ db: 'documind_test', session_user: 'documind_runtime', role: 'none' });

    await h.truncateAll();
    await helpers.clearOrgRateLimits();
    orgA = await h.createOrgWithUsers('rt-a', ['admin']);
    orgB = await h.createOrgWithUsers('rt-b', ['admin']);
    invA = await helpers.seedInviteWithToken({ organization_id: orgA.orgId, email: 'rt-invitee-a@documind.test', invited_by: orgA.users.admin.id });
    invB = await helpers.seedInviteWithToken({ organization_id: orgB.orgId, email: 'rt-invitee-b@documind.test', invited_by: orgB.users.admin.id });
  });

  afterAll(async () => {
    if (h) {
      await h.truncateAll();
      await helpers.clearOrgRateLimits();
    }
    if (rt) {
      await rt.pool.end();
      if (rt.redis.isOpen) await rt.redis.quit();
    }
    if (adminPool) await adminPool.end();
  });

  describe('connection identity (outside any tenant transaction)', () => {
    test('a non-superuser documind_runtime login that inherits documind_app', async () => {
      const { rows: [s] } = await rt.pool.query(
        `SELECT r.rolsuper, r.rolbypassrls, r.rolinherit,
                pg_has_role(session_user, 'documind_app', 'MEMBER') AS member_of_app,
                pg_has_role(session_user, 'documind_app', 'SET') AS can_set_app
         FROM pg_roles r WHERE r.rolname = session_user`,
      );
      expect(s).toMatchObject({ rolsuper: false, rolinherit: true, member_of_app: true, can_set_app: true });
      expect(typeof s.rolbypassrls).toBe('boolean'); // recorded, not asserted: F2 may remove BYPASSRLS
    });

    test('switching to the admin role is refused', async () => {
      const c = await rt.pool.connect();
      try {
        await c.query('BEGIN');
        const err = await c.query('SET LOCAL ROLE documind_admin').catch(e => e);
        expect(err.code).toBe('42501');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  describe('withTenantTransaction under the runtime login', () => {
    test('documind_app, transaction-local tenant, RLS active, READ COMMITTED; reset after COMMIT', async () => {
      const inside = await rt.withTenantTransaction(orgA.orgId, async (client) => {
        const { rows: [s] } = await client.query(CTX_SQL, [rt.env.PG_TENANT_SETTING]);
        const { rows: [r] } = await client.query(
          `SELECT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
                  row_security_active('organization_invitations') AS rls_invitations,
                  row_security_active('audit_logs') AS rls_audit,
                  current_setting('transaction_isolation') AS isolation`,
        );
        return { ...s, ...r };
      });
      expect(inside).toMatchObject({
        session_user: 'documind_runtime', current_user: 'documind_app', role: 'documind_app', tenant: orgA.orgId,
        bypassrls: false, rls_invitations: true, rls_audit: true, isolation: 'read committed',
      });
      expect(await stateOfPooledBackend(inside.pid)).toMatchObject({
        pid: inside.pid, session_user: 'documind_runtime', current_user: 'documind_runtime', role: 'none', tenant: '',
      });
    });

    test('role and tenant are also reset after ROLLBACK on the same connection', async () => {
      let pid;
      const err = await rt.withTenantTransaction(orgB.orgId, async (client) => {
        ({ rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid'));
        throw new Error('forced rollback');
      }).catch(e => e);
      expect(err.message).toBe('forced rollback');
      expect(await stateOfPooledBackend(pid)).toMatchObject({ pid, current_user: 'documind_runtime', role: 'none', tenant: '' });
    });
  });

  describe('cross-tenant isolation', () => {
    test('the token routing lookup resolves only the exact hash', async () => {
      const hashA = helpers.sha256(invA.token);
      const find = (v) => rt.invitationRepo.findOrganizationIdByTokenHash(rt.pool, v);
      expect({
        exact: await find(hashA), upper: await find(hashA.toUpperCase()), wildcard: await find(`${hashA.slice(0, 63)}%`),
        percent: await find('%'), raw: await find(invA.token),
      }).toEqual({ exact: orgA.orgId, upper: null, wildcard: null, percent: null, raw: null });
    });

    test('inside tenant A, organization B\'s invitations and audit rows are invisible and immutable', async () => {
      const out = await rt.withTenantTransaction(orgA.orgId, async (client) => {
        const q = async (sql, params) => client.query(sql, params);
        const visible = (await q('SELECT count(DISTINCT organization_id)::int AS orgs FROM organization_invitations')).rows[0].orgs;
        const byHash = (await q('SELECT count(*)::int AS n FROM organization_invitations WHERE token_hash = $1', [helpers.sha256(invB.token)])).rows[0].n;
        const updated = (await q("UPDATE organization_invitations SET status = 'revoked' WHERE id = $1", [invB.row.id])).rowCount;
        const deleted = (await q('DELETE FROM organization_invitations WHERE id = $1', [invB.row.id])).rowCount;
        await q('SAVEPOINT s');
        const inserted = await q(
          "INSERT INTO audit_logs (organization_id, actor_id, action) VALUES ($1, $2, 'CROSS_TENANT_ATTEMPT')",
          [orgB.orgId, orgA.users.admin.id],
        ).then(() => 'inserted', e => e.code);
        await q('ROLLBACK TO SAVEPOINT s');
        return { visible, byHash, updated, deleted, inserted };
      });
      expect(out).toEqual({ visible: 1, byHash: 0, updated: 0, deleted: 0, inserted: '42501' });
      expect((await adminPool.query('SELECT status FROM organization_invitations WHERE id = $1', [invB.row.id])).rows[0].status).toBe('pending');
    });
  });

  describe('real preview and acceptance through the runtime-connected app', () => {
    test('preview then accept succeed; membership, invitation and audit are written; org B untouched', async () => {
      const invitee = await helpers.createUser('rt-invitee-a@documind.test');
      const call = (path) => supertest(rt.app).post(`/api/invitations/${path}`)
        .set('Authorization', `Bearer ${invitee.token}`).send({ token: invA.token });

      const preview = await call('preview');
      expect(preview.status).toBe(200);
      expect(preview.body.data.invitation).toMatchObject({ organizationName: 'Org rt-a', role: invA.row.role });

      const accepted = await call('accept');
      expect(accepted.status).toBe(200);
      expect(accepted.body.data).toMatchObject({ organization: { id: orgA.orgId }, membership: { status: 'active' } });

      const { rows: [state] } = await adminPool.query(
        `SELECT (SELECT status FROM organization_invitations WHERE id = $1) AS invitation,
                (SELECT count(*)::int FROM memberships WHERE organization_id = $2 AND user_id = $3 AND status = 'active') AS memberships,
                (SELECT count(*)::int FROM audit_logs WHERE action = 'INVITATION_ACCEPT' AND resource_id = $1) AS audits,
                (SELECT count(*)::int FROM memberships WHERE organization_id = $4 AND user_id = $3) AS other_org,
                (SELECT status FROM organization_invitations WHERE id = $5) AS other_invitation`,
        [invA.row.id, orgA.orgId, invitee.id, orgB.orgId, invB.row.id],
      );
      expect(state).toEqual({ invitation: 'accepted', memberships: 1, audits: 1, other_org: 0, other_invitation: 'pending' });

      // A second acceptance of the same token is the generic 404 under this login too
      expect((await call('accept')).body).toEqual({ status: 'fail', message: 'Invitation not found or no longer valid.' });
    });
  });
});
