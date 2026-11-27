/**
 * Member removal (DELETE /api/organizations/:id/members/:userId) and member audit events.
 *  - admins only; soft removal (status 'removed'); access ends immediately
 *  - the last active admin can never be removed (409), also under concurrency
 *  - removal and its MEMBER_REMOVE audit entry commit or roll back together
 *  - cross-organization requests never touch another organization's members
 *  - role changes of active members are audited as MEMBER_ROLE_CHANGE (new members: MEMBER_ADD)
 * Real PostgreSQL (documind_test) and Redis test database.
 */

const supertest = require('supertest');
const { Client } = require('pg');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const auditRepo = require('../../src/repositories/audit.repository');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');

const api = (token, orgId) => {
  const req = supertest(app);
  const auth = (r) => {
    r.set('Authorization', `Bearer ${token}`);
    return orgId ? r.set('X-Organization-Id', orgId) : r;
  };
  return {
    get: (url) => auth(req.get(url)),
    post: (url) => auth(req.post(url)),
    del: (url) => auth(req.delete(url)),
  };
};
const email = (slug, role) => `${slug}_${role}@documind.test`;

let redis;
async function clearRateLimits() {
  const keys = [...await redis.keys('ratelimit:org:*'), ...await redis.keys('ratelimit:org-write:*')];
  if (keys.length) await redis.del(keys);
}
const membership = async (orgId, userId) => (await pool.query(
  'SELECT role, status FROM memberships WHERE organization_id = $1 AND user_id = $2', [orgId, userId])).rows[0];
const audits = async (orgId, action) => (await pool.query(
  'SELECT organization_id, actor_id, resource_id, metadata FROM audit_logs WHERE organization_id = $1 AND action = $2 ORDER BY created_at',
  [orgId, action])).rows;
const activeAdmins = async (orgId) => (await pool.query(
  "SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'admin' AND status = 'active'", [orgId])).rows[0].n;

beforeAll(async () => {
  await h.truncateAll();
  redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
});
beforeEach(clearRateLimits);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await h.truncateAll();
  await clearRateLimits();
  await pool.end();
});

describe('removing a member', () => {
  test('an admin removes a member: soft removal, MEMBER_REMOVE audit, access ends at once', async () => {
    const o = await h.createOrgWithUsers('rm-basic', ['admin', 'member']);
    // the member can use the organization before removal
    expect((await api(o.users.member.token, o.orgId).get('/api/documents')).status).toBe(200);

    const res = await api(o.users.admin.token).del(`/api/organizations/${o.orgId}/members/${o.users.member.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toEqual({ userId: o.users.member.id, role: 'member' });

    expect(await membership(o.orgId, o.users.member.id)).toEqual({ role: 'member', status: 'removed' });
    expect(await audits(o.orgId, 'MEMBER_REMOVE')).toEqual([{
      organization_id: o.orgId, actor_id: o.users.admin.id, resource_id: o.users.member.id, metadata: { role: 'member', self: false },
    }]);
    // the same token is refused on the very next request, and the member list no longer shows them
    expect((await api(o.users.member.token, o.orgId).get('/api/documents')).status).toBe(403);
    const list = await api(o.users.admin.token).get(`/api/organizations/${o.orgId}/members`);
    expect(list.body.data.members.map(m => m.id)).toEqual([o.users.admin.id]);
  });

  test('the last active admin cannot be removed (409) and nothing changes', async () => {
    const o = await h.createOrgWithUsers('rm-last', ['admin', 'member']);
    const res = await api(o.users.admin.token).del(`/api/organizations/${o.orgId}/members/${o.users.admin.id}`);
    expect(res.status).toBe(409);
    expect(await membership(o.orgId, o.users.admin.id)).toEqual({ role: 'admin', status: 'active' });
    expect(await audits(o.orgId, 'MEMBER_REMOVE')).toEqual([]);
  });

  test('an admin may remove themselves while another admin remains, and then loses admin access', async () => {
    const o = await h.createOrgWithUsers('rm-self', ['admin', 'member']);
    await pool.query("UPDATE memberships SET role = 'admin' WHERE organization_id = $1 AND user_id = $2", [o.orgId, o.users.member.id]);
    const res = await api(o.users.admin.token).del(`/api/organizations/${o.orgId}/members/${o.users.admin.id}`);
    expect(res.status).toBe(200);
    expect((await audits(o.orgId, 'MEMBER_REMOVE'))[0].metadata).toEqual({ role: 'admin', self: true });
    expect(await activeAdmins(o.orgId)).toBe(1);
    expect((await api(o.users.admin.token).get(`/api/organizations/${o.orgId}/members`)).status).toBe(403);
  });

  test.each(['member', 'viewer'])('a %s cannot remove anyone (403)', async (role) => {
    const o = await h.createOrgWithUsers(`rm-deny-${role}`, ['admin', role]);
    const res = await api(o.users[role].token).del(`/api/organizations/${o.orgId}/members/${o.users.admin.id}`);
    expect(res.status).toBe(403);
    expect(await membership(o.orgId, o.users.admin.id)).toEqual({ role: 'admin', status: 'active' });
  });

  test('unknown, already removed and malformed user IDs', async () => {
    const o = await h.createOrgWithUsers('rm-ids', ['admin', 'removed']);
    const base = `/api/organizations/${o.orgId}/members`;
    expect((await api(o.users.admin.token).del(`${base}/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await api(o.users.admin.token).del(`${base}/${o.users.removed.id}`)).status).toBe(404);
    expect((await api(o.users.admin.token).del(`${base}/not-a-uuid`)).status).toBe(400);
    expect((await api(o.users.admin.token).del(`/api/organizations/not-a-uuid/members/${o.users.admin.id}`)).status).toBe(400);
  });

  test('cross-organization: another organization\'s admin cannot remove members, and its own route cannot reach them', async () => {
    const a = await h.createOrgWithUsers('rm-xa', ['admin', 'member']);
    const b = await h.createOrgWithUsers('rm-xb', ['admin']);
    // B's admin on A's organization: not an admin there
    expect((await api(b.users.admin.token).del(`/api/organizations/${a.orgId}/members/${a.users.member.id}`)).status).toBe(403);
    // B's admin on B's organization with A's member id: not a member of B
    expect((await api(b.users.admin.token).del(`/api/organizations/${b.orgId}/members/${a.users.member.id}`)).status).toBe(404);
    expect(await membership(a.orgId, a.users.member.id)).toEqual({ role: 'member', status: 'active' });
    expect(await audits(a.orgId, 'MEMBER_REMOVE')).toEqual([]);
  });

  test('if the audit entry cannot be written, the removal rolls back', async () => {
    const o = await h.createOrgWithUsers('rm-atomic', ['admin', 'member']);
    const real = auditRepo.log.bind(auditRepo);
    jest.spyOn(auditRepo, 'log').mockImplementation((entry, db) => (
      entry.action === 'MEMBER_REMOVE' ? Promise.reject(new Error('audit insert failed')) : real(entry, db)));
    const res = await api(o.users.admin.token).del(`/api/organizations/${o.orgId}/members/${o.users.member.id}`);
    expect(res.status).toBe(500);
    expect(await membership(o.orgId, o.users.member.id)).toEqual({ role: 'member', status: 'active' });
  });

  test('two admins removing each other while queued on the organization lock: exactly one succeeds', async () => {
    const o = await h.createOrgWithUsers('rm-race', ['admin', 'member']);
    await pool.query("UPDATE memberships SET role = 'admin' WHERE organization_id = $1 AND user_id = $2", [o.orgId, o.users.member.id]);
    const holder = new Client({ connectionString: env.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [o.orgId]);
    let r1; let r2;
    try {
      r1 = api(o.users.admin.token).del(`/api/organizations/${o.orgId}/members/${o.users.member.id}`).then(r => r);
      r2 = api(o.users.member.token).del(`/api/organizations/${o.orgId}/members/${o.users.admin.id}`).then(r => r);
      const deadline = Date.now() + 10000;
      for (;;) {
        const { rows: [{ n }] } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE 'SELECT status FROM organizations WHERE id = $1 FOR NO KEY UPDATE%'`);
        if (n >= 2) break;
        if (Date.now() > deadline) throw new Error('requests did not queue on the lock');
        await new Promise(r => setTimeout(r, 25));
      }
    } finally {
      await holder.query('COMMIT');
      await holder.end();
    }
    const statuses = [(await r1).status, (await r2).status].sort();
    expect(statuses).toEqual([200, 403]); // the loser is no longer an admin when its turn comes
    expect(await activeAdmins(o.orgId)).toBe(1);
    expect(await audits(o.orgId, 'MEMBER_REMOVE')).toHaveLength(1);
  });
});

describe('member audit events', () => {
  test('re-adding a removed member is MEMBER_ADD; changing an active member\'s role is MEMBER_ROLE_CHANGE', async () => {
    const slug = 'rm-audit';
    const o = await h.createOrgWithUsers(slug, ['admin', 'removed']);
    const add = await api(o.users.admin.token).post(`/api/organizations/${o.orgId}/members`).send({ email: email(slug, 'removed'), role: 'viewer' });
    expect(add.status).toBe(201);
    expect(await membership(o.orgId, o.users.removed.id)).toEqual({ role: 'viewer', status: 'active' });
    expect((await audits(o.orgId, 'MEMBER_ADD')).map(a => a.metadata)).toEqual([{ email: email(slug, 'removed'), role: 'viewer' }]);

    const change = await api(o.users.admin.token).post(`/api/organizations/${o.orgId}/members`).send({ email: email(slug, 'removed'), role: 'member' });
    expect(change.status).toBe(201);
    expect((await audits(o.orgId, 'MEMBER_ROLE_CHANGE')).map(a => a.metadata)).toEqual([{ email: email(slug, 'removed'), previousRole: 'viewer', role: 'member' }]);
    expect(await audits(o.orgId, 'MEMBER_ADD')).toHaveLength(1);
  });

  test('adding an unregistered email returns 404 without echoing the address', async () => {
    const o = await h.createOrgWithUsers('rm-unknown', ['admin']);
    const res = await api(o.users.admin.token).post(`/api/organizations/${o.orgId}/members`).send({ email: 'nobody-here@example.com', role: 'member' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('nobody-here');
    expect(res.body.message).toMatch(/must register first/);
  });
});
