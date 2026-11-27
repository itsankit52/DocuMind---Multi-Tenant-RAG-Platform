/**
 * Phase 2 — admin invitation APIs: create, list, revoke, resend (behaviour and validation).
 * Security, rate-limit and concurrency cases live in invitations_api_security.test.js.
 */

const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const auditRepo = require('../../src/repositories/audit.repository');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, invitationUrl, seedInvite, getInvite, countInvites, auditRows,
  clearOrgRateLimits, PUBLIC_FIELDS,
} = require('./invitation.helpers');

const HOURS_72 = 72 * 3600 * 1000;
let orgA;
let orgB;

const asA = (role = 'admin') => api(orgA.users[role].token);

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('inv-api-a', ['admin', 'member', 'viewer']);
  orgB = await h.createOrgWithUsers('inv-api-b', ['admin']);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A. Create invitation', () => {
  test('an admin creates an invitation: 201, public fields only, secure token, hash stored, 72h expiry', async () => {
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: '  New.Member@Example.COM ', role: 'member' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { invitation, token, inviteUrl } = res.body.data;

    expect(Object.keys(invitation).sort()).toEqual(PUBLIC_FIELDS);
    expect(invitation).toMatchObject({
      organization_id: orgA.orgId, email: 'new.member@example.com', role: 'member', status: 'pending',
      invited_by: orgA.users.admin.id, accepted_by: null, revoked_by: null, accepted_at: null, revoked_at: null,
    });
    expect(res.text).not.toMatch(/token_hash/);

    // 32 random bytes as base64url = 43 characters, no padding
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(inviteUrl).toBeNull(); // APP_BASE_URL is not configured in tests

    const row = await getInvite(invitation.id);
    expect(row.token_hash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token); // the raw token is not stored anywhere

    const { rows: [{ exact }] } = await pool.query(
      "SELECT (expires_at - created_at) = interval '72 hours' AS exact FROM organization_invitations WHERE id = $1",
      [invitation.id],
    );
    expect(exact).toBe(true);
    expect(Math.abs(new Date(invitation.expires_at) - Date.now() - HOURS_72)).toBeLessThan(60 * 1000);
  });

  test('every invitation gets a different token', async () => {
    const a = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'one@documind.test', role: 'member' });
    const b = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'two@documind.test', role: 'member' });
    expect(a.body.data.token).not.toBe(b.body.data.token);
  });

  test('with APP_BASE_URL configured, the invite URL carries the token in the fragment', async () => {
    const original = env.APP_BASE_URL;
    env.APP_BASE_URL = 'https://app.documind.test';
    try {
      const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'url@documind.test', role: 'viewer' });
      expect(res.status).toBe(201);
      expect(res.body.data.inviteUrl).toBe(`https://app.documind.test/invite#token=${res.body.data.token}`);
      expect(res.body.data.inviteUrl).not.toContain('?');
    } finally {
      env.APP_BASE_URL = original;
    }
  });

  test.each(['admin', 'member', 'viewer'])('role %p is accepted', async (role) => {
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: `${role}-invitee@documind.test`, role });
    expect(res.status).toBe(201);
    expect(res.body.data.invitation.role).toBe(role);
  });

  test.each([
    ['malformed email', { email: 'not-an-email', role: 'member' }],
    ['empty email', { email: '', role: 'member' }],
    ['whitespace email', { email: '   ', role: 'member' }],
    ['non-string email', { email: 42, role: 'member' }],
    ['oversized email', { email: `${'x'.repeat(250)}@documind.test`, role: 'member' }],
    ['unsupported role', { email: 'a@documind.test', role: 'owner' }],
    ['uppercase role', { email: 'a@documind.test', role: 'Admin' }],
    ['missing role', { email: 'a@documind.test' }],
    ['missing body', undefined],
  ])('%s is rejected with 400 and nothing is stored', async (_label, body) => {
    const req = asA().post(invitationsUrl(orgA.orgId));
    const res = body === undefined ? await req : await req.send(body);
    expect(res.status).toBe(400);
    expect(await countInvites()).toBe(0);
  });

  test.each(['member', 'viewer'])('a %s cannot create invitations (403)', async (role) => {
    const res = await asA(role).post(invitationsUrl(orgA.orgId)).send({ email: 'x@documind.test', role: 'viewer' });
    expect(res.status).toBe(403);
    expect(await countInvites()).toBe(0);
  });

  test('unauthenticated requests are rejected (401)', async () => {
    const res = await api(null).post(invitationsUrl(orgA.orgId)).send({ email: 'x@documind.test', role: 'member' });
    expect(res.status).toBe(401);
  });

  test('an invalid organization UUID is rejected (400)', async () => {
    const res = await asA().post(invitationsUrl('not-a-uuid')).send({ email: 'x@documind.test', role: 'member' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Organization ID must be a valid UUID.');
  });

  test('organization A admin cannot create an invitation for organization B (403)', async () => {
    const res = await asA().post(invitationsUrl(orgB.orgId)).send({ email: 'x@documind.test', role: 'admin' });
    expect(res.status).toBe(403);
    expect(await countInvites('organization_id = $1', [orgB.orgId])).toBe(0);
  });

  test('an inactive (suspended) organization is rejected (403)', async () => {
    await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [orgA.orgId]);
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'x@documind.test', role: 'member' });
    expect(res.status).toBe(403);
    expect(await countInvites()).toBe(0);
  });

  test('a removed (inactive) admin membership is rejected (403)', async () => {
    await pool.query("UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, orgA.users.admin.id]);
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'x@documind.test', role: 'member' });
    expect(res.status).toBe(403);
  });

  test('a second active invitation for the same email is rejected (409), even with different case', async () => {
    const first = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'dup@documind.test', role: 'member' });
    expect(first.status).toBe(201);
    const second = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'DUP@documind.test', role: 'admin' });
    expect(second.status).toBe(409);
    expect(second.body.message).toBe('A pending invitation already exists for this email address.');
    expect(await countInvites("email = 'dup@documind.test'")).toBe(1);
  });

  test('an expired pending invitation is transitioned to expired before the new one is created', async () => {
    const stale = await seedInvite({
      organization_id: orgA.orgId, email: 'stale@documind.test',
      created_at: new Date(Date.now() - 100 * 3600 * 1000), expires_at: new Date(Date.now() - 3600 * 1000),
    });
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'stale@documind.test', role: 'member' });
    expect(res.status).toBe(201);
    expect((await getInvite(stale.id)).status).toBe('expired');
    expect(res.body.data.invitation.id).not.toBe(stale.id);
    expect(await countInvites("email = 'stale@documind.test' AND status = 'pending'")).toBe(1);
  });

  test('the same email can be invited by two different organizations', async () => {
    const a = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'both@documind.test', role: 'member' });
    const b = await api(orgB.users.admin.token).post(invitationsUrl(orgB.orgId)).send({ email: 'both@documind.test', role: 'viewer' });
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  test('an INVITATION_CREATE audit entry is written without token data', async () => {
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'audit@documind.test', role: 'viewer' });
    const { invitation, token } = res.body.data;
    const rows = await auditRows('INVITATION_CREATE', invitation.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: orgA.orgId, actor_id: orgA.users.admin.id });
    expect(rows[0].metadata).toMatchObject({ invitationId: invitation.id, email: 'audit@documind.test', role: 'viewer' });
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(sha256(token));
  });

  test('if the audit insert fails, the invitation is rolled back (500, no leak)', async () => {
    jest.spyOn(auditRepo, 'log').mockImplementationOnce(async (_entry, db) => {
      expect(db).not.toBe(pool);
      await db.query('SELECT 1/0');
    });
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'rollback@documind.test', role: 'member' });
    expect(res.status).toBe(500);
    expect(res.body.message).not.toMatch(/division|SELECT/i);
    expect(await countInvites()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. List invitations', () => {
  test('an admin lists invitations with public fields only (no token data) and pagination metadata', async () => {
    const created = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'list@documind.test', role: 'member' });
    const res = await asA().get(invitationsUrl(orgA.orgId));
    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, totalCount: 1, totalPages: 1 });
    expect(res.body.data.invitations).toHaveLength(1);
    expect(Object.keys(res.body.data.invitations[0]).sort()).toEqual(PUBLIC_FIELDS);
    expect(res.text).not.toMatch(/token_hash/);
    expect(res.text).not.toContain(created.body.data.token);
    expect(res.text).not.toContain(sha256(created.body.data.token));
  });

  test.each(['member', 'viewer'])('a %s cannot list invitations (403)', async (role) => {
    expect((await asA(role).get(invitationsUrl(orgA.orgId))).status).toBe(403);
  });

  test('pagination pages through results in deterministic order (created_at DESC, id DESC)', async () => {
    const base = Date.now() - 10 * 60 * 1000;
    const seeded = [];
    for (let i = 0; i < 4; i += 1) {
      seeded.push(await seedInvite({ organization_id: orgA.orgId, email: `p${i}@documind.test`, created_at: new Date(base + i * 1000) }));
    }
    // Two rows with the same created_at: ordered by id DESC
    const tieTime = new Date(base + 10 * 1000);
    seeded.push(await seedInvite({ organization_id: orgA.orgId, email: 'tie1@documind.test', created_at: tieTime }));
    seeded.push(await seedInvite({ organization_id: orgA.orgId, email: 'tie2@documind.test', created_at: tieTime }));

    const expected = [...seeded]
      .sort((x, y) => (y.created_at - x.created_at) || (y.id < x.id ? -1 : 1))
      .map(r => r.id);

    const ids = [];
    for (const page of [1, 2, 3]) {
      const res = await asA().get(`${invitationsUrl(orgA.orgId)}?page=${page}&limit=2`);
      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toEqual({ page, limit: 2, totalCount: 6, totalPages: 3 });
      ids.push(...res.body.data.invitations.map(i => i.id));
    }
    expect(ids).toEqual(expected);
    const beyond = await asA().get(`${invitationsUrl(orgA.orgId)}?page=4&limit=2`);
    expect(beyond.body.data.invitations).toEqual([]);
    expect(beyond.body.data.pagination).toEqual({ page: 4, limit: 2, totalCount: 6, totalPages: 3 });
  });

  test('an out-of-range page is empty but keeps the correct totals, with and without a status filter (F2)', async () => {
    for (let i = 0; i < 3; i += 1) await seedInvite({ organization_id: orgA.orgId, email: `pend${i}@documind.test` });
    await seedInvite({ organization_id: orgA.orgId, email: 'rev@documind.test', status: 'revoked', revoked_at: new Date() });
    await seedInvite({
      organization_id: orgA.orgId, email: 'overdue2@documind.test',
      created_at: new Date(Date.now() - 100 * 3600 * 1000), expires_at: new Date(Date.now() - 3600 * 1000),
    });
    await seedInvite({ organization_id: orgB.orgId, email: 'other-org@documind.test' }); // never counted for A

    const get = async (query) => {
      const res = await asA().get(`${invitationsUrl(orgA.orgId)}?${query}`);
      expect(res.status).toBe(200);
      return res.body.data;
    };

    const first = await get('page=1&limit=2');
    expect(first.invitations).toHaveLength(2);
    expect(first.pagination).toEqual({ page: 1, limit: 2, totalCount: 5, totalPages: 3 });
    expect(await get('page=500&limit=2')).toEqual({ invitations: [], pagination: { page: 500, limit: 2, totalCount: 5, totalPages: 3 } });

    const pendingFirst = await get('status=pending&page=1&limit=2');
    expect(pendingFirst.invitations.map(i => i.status)).toEqual(['pending', 'pending']);
    expect(pendingFirst.pagination).toEqual({ page: 1, limit: 2, totalCount: 3, totalPages: 2 });
    expect((await get('status=pending&page=9999&limit=2')).pagination).toEqual({ page: 9999, limit: 2, totalCount: 3, totalPages: 2 });
    // Effective status: the overdue pending row counts as expired, also on an empty page
    expect((await get('status=expired&page=1')).pagination.totalCount).toBe(1);
    expect((await get('status=expired&page=7')).pagination).toEqual({ page: 7, limit: 20, totalCount: 1, totalPages: 1 });
  });

  test('an organization without invitations reports zero totals', async () => {
    expect((await asA().get(invitationsUrl(orgA.orgId))).body.data)
      .toEqual({ invitations: [], pagination: { page: 1, limit: 20, totalCount: 0, totalPages: 0 } });
    expect((await asA().get(`${invitationsUrl(orgA.orgId)}?page=3`)).body.data.pagination)
      .toEqual({ page: 3, limit: 20, totalCount: 0, totalPages: 0 });
  });

  test('status filter returns only that effective status; an overdue pending invitation is reported as expired', async () => {
    await seedInvite({ organization_id: orgA.orgId, email: 'pending@documind.test' });
    await seedInvite({ organization_id: orgA.orgId, email: 'accepted@documind.test', status: 'accepted', accepted_at: new Date() });
    await seedInvite({ organization_id: orgA.orgId, email: 'revoked@documind.test', status: 'revoked', revoked_at: new Date() });
    await seedInvite({ organization_id: orgA.orgId, email: 'expired@documind.test', status: 'expired' });
    const overdue = await seedInvite({
      organization_id: orgA.orgId, email: 'overdue@documind.test',
      created_at: new Date(Date.now() - 100 * 3600 * 1000), expires_at: new Date(Date.now() - 3600 * 1000),
    });

    const emailsFor = async (status) => {
      const res = await asA().get(`${invitationsUrl(orgA.orgId)}?status=${status}`);
      expect(res.status).toBe(200);
      return res.body.data.invitations.map(i => i.email).sort();
    };
    expect(await emailsFor('pending')).toEqual(['pending@documind.test']);
    expect(await emailsFor('accepted')).toEqual(['accepted@documind.test']);
    expect(await emailsFor('revoked')).toEqual(['revoked@documind.test']);
    expect(await emailsFor('expired')).toEqual(['expired@documind.test', 'overdue@documind.test']);
    // Listing is read-only: the stored status of the overdue row is unchanged
    expect((await getInvite(overdue.id)).status).toBe('pending');
  });

  test.each([
    'page=0', 'page=-1', 'page=abc', 'page=1.5', 'limit=0', 'limit=101', 'limit=abc',
    'status=deleted', "status=pending'%20OR%201=1", 'page=1&page=2',
  ])('invalid query %p is rejected (400)', async (query) => {
    expect((await asA().get(`${invitationsUrl(orgA.orgId)}?${query}`)).status).toBe(400);
  });

  test("organization isolation: A's list never contains B's invitations, and A cannot list B's", async () => {
    await seedInvite({ organization_id: orgA.orgId, email: 'a-only@documind.test' });
    await seedInvite({ organization_id: orgB.orgId, email: 'b-only@documind.test' });
    const res = await asA().get(invitationsUrl(orgA.orgId));
    expect(res.body.data.invitations.map(i => i.email)).toEqual(['a-only@documind.test']);
    expect(res.body.data.invitations.every(i => i.organization_id === orgA.orgId)).toBe(true);
    expect((await asA().get(invitationsUrl(orgB.orgId))).status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. Revoke invitation', () => {
  test('an admin revokes a pending invitation: status, revoked_at, revoked_by and audit', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId, invited_by: orgA.users.admin.id });
    const res = await asA().delete(invitationUrl(orgA.orgId, inv.id));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.invitation).sort()).toEqual(PUBLIC_FIELDS);
    expect(res.body.data.invitation).toMatchObject({ id: inv.id, status: 'revoked', revoked_by: orgA.users.admin.id });
    expect(res.text).not.toMatch(/token/);

    const row = await getInvite(inv.id);
    expect(row.status).toBe('revoked');
    expect(row.revoked_by).toBe(orgA.users.admin.id);
    expect(Math.abs(row.revoked_at - Date.now())).toBeLessThan(60 * 1000);
    expect(row.updated_at.getTime()).toBe(row.revoked_at.getTime());

    const audit = await auditRows('INVITATION_REVOKE', inv.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organization_id: orgA.orgId, actor_id: orgA.users.admin.id });
    expect(JSON.stringify(audit[0])).not.toContain(row.token_hash);
  });

  test.each(['member', 'viewer'])('a %s cannot revoke (403) and nothing changes', async (role) => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    expect((await asA(role).delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(403);
    expect((await getInvite(inv.id)).status).toBe('pending');
  });

  test("another organization's invitation is not found through this organization (404) and is unchanged", async () => {
    const invB = await seedInvite({ organization_id: orgB.orgId });
    const res = await asA().delete(invitationUrl(orgA.orgId, invB.id));
    expect(res.status).toBe(404);
    expect((await getInvite(invB.id)).status).toBe('pending');
  });

  test('an unknown invitation is 404 and an invalid invitation UUID is 400', async () => {
    expect((await asA().delete(invitationUrl(orgA.orgId, '00000000-0000-4000-8000-000000000000'))).status).toBe(404);
    const bad = await asA().delete(invitationUrl(orgA.orgId, 'nope'));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('Invitation ID must be a valid UUID.');
  });

  test.each([
    ['accepted', { status: 'accepted', accepted_at: new Date() }, 'This invitation has already been accepted.'],
    ['already revoked', { status: 'revoked', revoked_at: new Date() }, 'This invitation has been revoked.'],
    ['expired', { status: 'expired' }, 'This invitation has expired.'],
  ])('a %s invitation cannot be revoked (409) and is unchanged', async (_label, fields, message) => {
    const inv = await seedInvite({ organization_id: orgA.orgId, ...fields });
    const res = await asA().delete(invitationUrl(orgA.orgId, inv.id));
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(message);
    expect((await getInvite(inv.id)).status).toBe(fields.status);
  });

  test('an overdue pending invitation is marked expired (committed) and reported as expired (409)', async () => {
    const inv = await seedInvite({
      organization_id: orgA.orgId,
      created_at: new Date(Date.now() - 100 * 3600 * 1000), expires_at: new Date(Date.now() - 3600 * 1000),
    });
    const res = await asA().delete(invitationUrl(orgA.orgId, inv.id));
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This invitation has expired.');
    const row = await getInvite(inv.id);
    expect(row.status).toBe('expired');
    expect(row.revoked_at).toBeNull();
  });

  test('if the audit insert fails, the revocation is rolled back', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    jest.spyOn(auditRepo, 'log').mockImplementationOnce(async (_entry, db) => { await db.query('SELECT 1/0'); });
    expect((await asA().delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(500);
    const row = await getInvite(inv.id);
    expect(row.status).toBe('pending');
    expect(row.revoked_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D. Resend invitation', () => {
  async function createViaApi(email = 'resend@documind.test') {
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email, role: 'member' });
    return res.body.data;
  }

  test('an admin resends: new token and hash, previous token invalid, expiry reset to 72h, audit', async () => {
    const { invitation, token: oldToken } = await createViaApi();
    const before = await getInvite(invitation.id);

    const res = await asA().post(`${invitationUrl(orgA.orgId, invitation.id)}/resend`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { invitation: resent, token: newToken, inviteUrl } = res.body.data;
    expect(Object.keys(resent).sort()).toEqual(PUBLIC_FIELDS);
    expect(resent).toMatchObject({ id: invitation.id, status: 'pending', email: 'resend@documind.test' });
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken).not.toBe(oldToken);
    expect(inviteUrl).toBeNull();
    expect(res.text).not.toContain(oldToken);
    expect(res.text).not.toMatch(/token_hash/);

    const after = await getInvite(invitation.id);
    expect(after.token_hash).toBe(sha256(newToken));
    expect(await countInvites('token_hash = $1', [sha256(oldToken)])).toBe(0); // old token no longer matches
    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
    expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());
    const { rows: [{ exact }] } = await pool.query(
      "SELECT (expires_at - updated_at) = interval '72 hours' AS exact FROM organization_invitations WHERE id = $1",
      [invitation.id],
    );
    expect(exact).toBe(true);

    const audit = await auditRows('INVITATION_RESEND', invitation.id);
    expect(audit).toHaveLength(1);
    const serialized = JSON.stringify(audit[0]);
    for (const secret of [oldToken, newToken, sha256(oldToken), sha256(newToken)]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test.each(['member', 'viewer'])('a %s cannot resend (403) and the token is unchanged', async (role) => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    expect((await asA(role).post(`${invitationUrl(orgA.orgId, inv.id)}/resend`)).status).toBe(403);
    expect((await getInvite(inv.id)).token_hash).toBe(inv.token_hash);
  });

  test("another organization's invitation cannot be resent through this organization (404)", async () => {
    const invB = await seedInvite({ organization_id: orgB.orgId });
    expect((await asA().post(`${invitationUrl(orgA.orgId, invB.id)}/resend`)).status).toBe(404);
    expect((await getInvite(invB.id)).token_hash).toBe(invB.token_hash);
  });

  test.each([
    ['accepted', { status: 'accepted', accepted_at: new Date() }],
    ['revoked', { status: 'revoked', revoked_at: new Date() }],
    ['expired', { status: 'expired' }],
  ])('a %s invitation cannot be resent (409); no token is returned and nothing changes', async (_label, fields) => {
    const inv = await seedInvite({ organization_id: orgA.orgId, ...fields });
    const res = await asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`);
    expect(res.status).toBe(409);
    expect(res.body.data).toBeUndefined();
    const row = await getInvite(inv.id);
    expect(row.status).toBe(fields.status);
    expect(row.token_hash).toBe(inv.token_hash);
  });

  test('an overdue pending invitation is not silently revived: marked expired, 409, token unchanged', async () => {
    const inv = await seedInvite({
      organization_id: orgA.orgId,
      created_at: new Date(Date.now() - 100 * 3600 * 1000), expires_at: new Date(Date.now() - 3600 * 1000),
    });
    const res = await asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This invitation has expired.');
    const row = await getInvite(inv.id);
    expect(row.status).toBe('expired');
    expect(row.token_hash).toBe(inv.token_hash);
    expect(row.expires_at.getTime()).toBe(inv.expires_at.getTime());
  });

  test('if the audit insert fails, the resend is rolled back (old token still valid)', async () => {
    const { invitation, token } = await createViaApi('resend-rollback@documind.test');
    const before = await getInvite(invitation.id);
    jest.spyOn(auditRepo, 'log').mockImplementationOnce(async (_entry, db) => { await db.query('SELECT 1/0'); });
    const res = await asA().post(`${invitationUrl(orgA.orgId, invitation.id)}/resend`);
    expect(res.status).toBe(500);
    expect(res.body.data).toBeUndefined();
    const after = await getInvite(invitation.id);
    expect(after.token_hash).toBe(sha256(token));
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
  });
});
