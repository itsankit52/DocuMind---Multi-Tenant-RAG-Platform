/**
 * Phase 3 — invitee-facing APIs: POST /api/invitations/preview and POST /api/invitations/accept
 * (Phase 3.2C/F3: the token travels only in the JSON body; GET /preview?token=… was removed).
 * Behaviour and validation. Concurrency, rollback and leakage tests live in
 * invitations_accept_security.test.js.
 */

const supertest = require('supertest');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, invitationUrl, getInvite, auditRows, clearOrgRateLimits,
  newToken, createUser, seedInviteWithToken, membershipOf, inconsistentAcceptedInvitations,
} = require('./invitation.helpers');

const INVALID = { status: 'fail', message: 'Invitation not found or no longer valid.' };
const HOUR = 3600 * 1000;
let orgA;
let orgB;
let invitee;

const preview = (token, userToken = invitee.token) =>
  api(userToken).post('/api/invitations/preview').send(token === undefined ? {} : { token });
const accept = (body, userToken = invitee.token) => api(userToken).post('/api/invitations/accept').send(body);

/** Create an invitation through the Phase 2 API (real token). */
async function invite(email, role = 'member', org = orgA) {
  const res = await api(org.users.admin.token).post(invitationsUrl(org.orgId)).send({ email, role });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function clearAuthRateLimits() {
  const redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
  const keys = await redis.keys('ratelimit:auth:*');
  if (keys.length) await redis.del(keys);
}

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('acc-a', ['admin', 'member']);
  orgB = await h.createOrgWithUsers('acc-b', ['admin']);
  invitee = await createUser('invitee@documind.test', { fullName: 'Ivy Invitee' });
});

afterEach(async () => {
  jest.restoreAllMocks();
  expect(await inconsistentAcceptedInvitations()).toEqual([]);
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Preview', () => {
  test('a valid pending invitation returns only organization name, role, inviter name and expiry', async () => {
    const { token, invitation } = await invite('invitee@documind.test', 'viewer');
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toEqual({
      status: 'success',
      data: {
        invitation: {
          organizationName: 'Org acc-a',
          role: 'viewer',
          inviterName: 'acc-a admin',
          expiresAt: new Date(invitation.expires_at).toISOString(),
        },
      },
    });
    for (const secret of [token, sha256(token), invitation.id, orgA.orgId, orgA.users.admin.id, 'acc-a_admin@documind.test']) {
      expect(res.text).not.toContain(secret);
    }
  });

  test('preview is read-only: no membership, invitation stays pending', async () => {
    const { token, invitation } = await invite('invitee@documind.test', 'admin');
    expect((await preview(token)).status).toBe(200);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    const row = await getInvite(invitation.id);
    expect(row).toMatchObject({ status: 'pending', accepted_by: null, accepted_at: null });
  });

  test('missing token → 400', async () => {
    expect((await preview(undefined)).status).toBe(400);
    expect((await preview('')).status).toBe(400);
  });

  test.each([
    ['too short', 'abc'],
    ['too long', 'A'.repeat(44)],
    ['padding', `${'A'.repeat(42)}=`],
    ['invalid characters', `${'A'.repeat(42)}+`],
    ['SQL', "' OR 1=1 --aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])('malformed token (%s) → 400', async (_label, token) => {
    expect((await preview(token)).status).toBe(400);
  });

  test('a token array (repeated token) → 400', async () => {
    const res = await api(invitee.token).post('/api/invitations/preview').send({ token: [newToken(), newToken()] });
    expect(res.status).toBe(400);
  });

  test('an unknown well-formed token → generic 404', async () => {
    const res = await preview(newToken());
    expect(res.status).toBe(404);
    expect(res.body).toEqual(INVALID);
  });

  test.each([
    ['expired', { created_at: new Date(Date.now() - 100 * HOUR), expires_at: new Date(Date.now() - HOUR) }],
    ['revoked', { status: 'revoked', revoked_at: new Date() }],
    ['accepted', { status: 'accepted', accepted_at: new Date(), accepted_by: 'MEMBER' }],
    ['already expired', { status: 'expired' }],
  ])('%s invitation → identical generic 404 (nothing written)', async (_label, fields) => {
    // A realistic accepted row: accepted by a user who holds the active membership
    const resolved = fields.accepted_by === 'MEMBER' ? { ...fields, accepted_by: orgA.users.member.id } : fields;
    const { row, token } = await seedInviteWithToken({
      organization_id: orgA.orgId, email: 'invitee@documind.test', invited_by: orgA.users.admin.id, ...resolved,
    });
    const res = await preview(token);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(INVALID);
    expect((await getInvite(row.id)).status).toBe(row.status); // preview never transitions
  });

  test.each(['suspended', 'deleted'])('%s organization → generic 404', async (status) => {
    const { token } = await invite('invitee@documind.test');
    await pool.query('UPDATE organizations SET status = $1 WHERE id = $2', [status, orgA.orgId]);
    const res = await preview(token);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(INVALID);
  });

  test('organization row removed (cascade) → generic 404', async () => {
    const { token } = await invite('invitee@documind.test');
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgA.orgId]);
    expect((await preview(token)).body).toEqual(INVALID);
  });

  test.each([
    ['removed from the organization', "UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2"],
    ['demoted from admin', "UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2"],
  ])('inviter %s → generic 404', async (_label, sql) => {
    const { token } = await invite('invitee@documind.test');
    await pool.query(sql, [orgA.orgId, orgA.users.admin.id]);
    expect((await preview(token)).body).toEqual(INVALID);
  });

  test('inviter account disabled or deleted → generic 404', async () => {
    const { token } = await invite('invitee@documind.test');
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [orgA.users.admin.id]);
    expect((await preview(token)).body).toEqual(INVALID);

    const seeded = await seedInviteWithToken({ organization_id: orgA.orgId, email: 'invitee2@documind.test', invited_by: null });
    const other = await createUser('invitee2@documind.test');
    expect((await preview(seeded.token, other.token)).body).toEqual(INVALID);
  });

  test('email mismatch → the same generic 404 as an unknown token', async () => {
    const { token } = await invite('someone-else@documind.test');
    const mismatch = await preview(token);
    const unknown = await preview(newToken());
    expect(mismatch.status).toBe(404);
    expect(mismatch.body).toEqual(unknown.body);
  });

  test('email comparison is case-insensitive', async () => {
    const mixed = await createUser('Mixed.Case@Documind.TEST');
    const { token } = await invite('mixed.case@documind.test');
    expect((await preview(token, mixed.token)).status).toBe(200);
  });

  test('email comparison ignores surrounding whitespace in the stored account email', async () => {
    const spaced = await createUser('  spaced@documind.test  ');
    const { token } = await invite('spaced@documind.test');
    expect((await preview(token, spaced.token)).status).toBe(200);
  });

  test('unauthenticated → 401 (existing auth middleware)', async () => {
    const { token } = await invite('invitee@documind.test');
    expect((await supertest(app).post('/api/invitations/preview').send({ token })).status).toBe(401);
  });

  test('two organizations inviting the same user: each token previews only its own organization', async () => {
    const a = await invite('invitee@documind.test', 'member', orgA);
    const b = await invite('invitee@documind.test', 'admin', orgB);
    const resA = await preview(a.token);
    const resB = await preview(b.token);
    expect(resA.body.data.invitation).toMatchObject({ organizationName: 'Org acc-a', role: 'member' });
    expect(resB.body.data.invitation).toMatchObject({ organizationName: 'Org acc-b', role: 'admin' });
    expect(resA.text).not.toContain('acc-b');
    expect(resB.text).not.toContain('acc-a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Acceptance', () => {
  const expectAccepted = async (res, { org = orgA, role, userId = invitee.id }) => {
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      status: 'success',
      data: { organization: { id: org.orgId, name: `Org ${org === orgA ? 'acc-a' : 'acc-b'}` }, membership: { role, status: 'active' } },
    });
    const memberships = await membershipOf(org.orgId, userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ role, status: 'active' });
  };

  test('a newly registered user (real register + login) accepts an invitation', async () => {
    await clearAuthRateLimits();
    const { token } = await invite('fresh@documind.test', 'member');
    const reg = await supertest(app).post('/api/auth/register')
      .send({ email: 'Fresh@documind.test', password: 'Password123!', fullName: 'Fresh User' });
    expect(reg.status).toBe(201);
    const login = await supertest(app).post('/api/auth/login').send({ email: 'fresh@documind.test', password: 'Password123!' });
    expect(login.status).toBe(200);
    const { rows: [user] } = await pool.query("SELECT id FROM users WHERE lower(email) = 'fresh@documind.test'");

    const res = await accept({ token }, login.body.data.accessToken);
    await expectAccepted(res, { role: 'member', userId: user.id });
  });

  test('an existing user accepts: membership created with the invited role, invitation accepted, audited', async () => {
    const { token, invitation } = await invite('invitee@documind.test', 'viewer');
    const res = await accept({ token });
    await expectAccepted(res, { role: 'viewer' });

    const row = await getInvite(invitation.id);
    expect(row).toMatchObject({ status: 'accepted', accepted_by: invitee.id });
    expect(row.accepted_at).not.toBeNull();
    expect(row.updated_at.getTime()).toBe(row.accepted_at.getTime());

    const audit = await auditRows('INVITATION_ACCEPT', invitation.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organization_id: orgA.orgId, actor_id: invitee.id });
    expect(audit[0].metadata).toMatchObject({
      invitationId: invitation.id, role: 'viewer', membershipAction: 'created', previousMembershipStatus: null,
    });
    const serialized = JSON.stringify(audit[0]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(sha256(token));
  });

  test('a Google (OAuth-only, no password) user accepts', async () => {
    const google = await createUser('google.user@documind.test', { google: true });
    const { token } = await invite('google.user@documind.test', 'member');
    await expectAccepted(await accept({ token }, google.token), { role: 'member', userId: google.id });
  });

  test('a member of another organization accepts; the other membership is untouched', async () => {
    await pool.query("INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')", [orgB.orgId, invitee.id]);
    const { token } = await invite('invitee@documind.test', 'viewer');
    await expectAccepted(await accept({ token }), { role: 'viewer' });
    expect(await membershipOf(orgB.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'admin', status: 'active' })]);
  });

  test.each(['removed', 'invited'])('a %s membership is reactivated in place with the invited role', async (status) => {
    await pool.query("INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'admin', $3)", [orgA.orgId, invitee.id, status]);
    const [before] = await membershipOf(orgA.orgId, invitee.id);
    const { token, invitation } = await invite('invitee@documind.test', 'viewer');

    await expectAccepted(await accept({ token }), { role: 'viewer' });
    const [after] = await membershipOf(orgA.orgId, invitee.id);
    expect(after.id).toBe(before.id); // same row: no duplicate
    expect(after.created_at.getTime()).toBe(before.created_at.getTime()); // history kept
    expect((await auditRows('INVITATION_ACCEPT', invitation.id))[0].metadata)
      .toMatchObject({ membershipAction: 'reactivated', previousMembershipStatus: status });
  });

  test('an admin invitation grants admin', async () => {
    const { token } = await invite('invitee@documind.test', 'admin');
    await expectAccepted(await accept({ token }), { role: 'admin' });
  });

  test.each([
    ['role', { role: 'admin' }],
    ['organizationId', { organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['organization_id', { organization_id: '00000000-0000-4000-8000-000000000000' }],
    ['email', { email: 'other@documind.test' }],
    ['status', { status: 'active' }],
  ])('a client-supplied %s is rejected (400) and nothing changes', async (_label, extra) => {
    const { token, invitation } = await invite('invitee@documind.test', 'viewer');
    const res = await accept({ token, ...extra });
    expect(res.status).toBe(400);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    expect((await getInvite(invitation.id)).status).toBe('pending');
  });

  test.each([
    ['missing body', undefined],
    ['missing token', {}],
    ['malformed token', { token: 'short' }],
    ['non-string token', { token: 12345 }],
  ])('%s → 400', async (_label, body) => {
    const req = api(invitee.token).post('/api/invitations/accept');
    expect((await (body === undefined ? req : req.send(body))).status).toBe(400);
  });

  test.each([
    ['member', 'admin'], ['viewer', 'admin'], ['admin', 'viewer'], ['member', 'member'],
  ])('an active %s accepting a(n) %s invitation gets 409 ALREADY_ORGANIZATION_MEMBER; role unchanged', async (currentRole, invitedRole) => {
    await pool.query('INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, $3, \'active\')', [orgA.orgId, invitee.id, currentRole]);
    const { token, invitation } = await invite('invitee@documind.test', invitedRole);
    const res = await accept({ token });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ status: 'fail', message: 'You are already a member of this organization.', code: 'ALREADY_ORGANIZATION_MEMBER' });
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: currentRole, status: 'active' })]);
    expect((await getInvite(invitation.id)).status).toBe('pending');
    expect(await auditRows('INVITATION_ACCEPT', invitation.id)).toEqual([]);
  });

  test('an overdue pending invitation is rejected (404) and transitioned to expired', async () => {
    const { row, token } = await seedInviteWithToken({
      organization_id: orgA.orgId, email: 'invitee@documind.test', invited_by: orgA.users.admin.id,
      created_at: new Date(Date.now() - 100 * HOUR), expires_at: new Date(Date.now() - HOUR),
    });
    expect((await accept({ token })).body).toEqual(INVALID);
    expect((await getInvite(row.id)).status).toBe('expired');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
  });

  test('a revoked invitation is rejected', async () => {
    const { token, invitation } = await invite('invitee@documind.test');
    expect((await api(orgA.users.admin.token).delete(invitationUrl(orgA.orgId, invitation.id))).status).toBe(200);
    expect((await accept({ token })).body).toEqual(INVALID);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
  });

  test('an accepted invitation cannot be accepted again (not even by the same user)', async () => {
    const { token } = await invite('invitee@documind.test');
    expect((await accept({ token })).status).toBe(200);
    const again = await accept({ token });
    expect(again.status).toBe(404);
    expect(again.body).toEqual(INVALID);
    expect(await membershipOf(orgA.orgId, invitee.id)).toHaveLength(1);
  });

  test('the token replaced by a resend no longer works; the new one does', async () => {
    const { token: oldToken, invitation } = await invite('invitee@documind.test');
    const resent = await api(orgA.users.admin.token).post(`${invitationUrl(orgA.orgId, invitation.id)}/resend`);
    expect((await accept({ token: oldToken })).body).toEqual(INVALID);
    expect((await accept({ token: resent.body.data.token })).status).toBe(200);
  });

  test('another user cannot accept an invitation addressed to a different email', async () => {
    const { token, invitation } = await invite('invitee@documind.test');
    const intruder = await createUser('intruder@documind.test');
    const res = await accept({ token }, intruder.token);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(INVALID);
    expect(await membershipOf(orgA.orgId, intruder.id)).toEqual([]);
    expect((await getInvite(invitation.id)).status).toBe('pending');
    // An existing member of the org (different email) cannot use it either
    expect((await accept({ token }, orgA.users.member.token)).body).toEqual(INVALID);
  });

  test.each([
    ['inviter demoted', "UPDATE memberships SET role = 'viewer' WHERE organization_id = $1 AND user_id = $2"],
    ['inviter removed', "UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2"],
  ])('%s before acceptance → 404, nothing created', async (_label, sql) => {
    const { token, invitation } = await invite('invitee@documind.test');
    await pool.query(sql, [orgA.orgId, orgA.users.admin.id]);
    expect((await accept({ token })).body).toEqual(INVALID);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    expect((await getInvite(invitation.id)).status).toBe('pending');
  });

  test.each(['suspended', 'deleted'])('organization %s before acceptance → 404, nothing created', async (status) => {
    const { token, invitation } = await invite('invitee@documind.test');
    await pool.query('UPDATE organizations SET status = $1 WHERE id = $2', [status, orgA.orgId]);
    expect((await accept({ token })).body).toEqual(INVALID);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    expect((await getInvite(invitation.id)).status).toBe('pending');
  });

  test('a second invitation for an already-joined user → 409, no duplicate membership, role unchanged', async () => {
    const first = await invite('invitee@documind.test', 'viewer');
    expect((await accept({ token: first.token })).status).toBe(200);
    const second = await invite('invitee@documind.test', 'admin'); // allowed: the first is no longer pending
    const res = await accept({ token: second.token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ORGANIZATION_MEMBER');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'viewer', status: 'active' })]);
    expect((await getInvite(second.invitation.id)).status).toBe('pending');
  });

  test('a disabled invitee cannot accept (auth middleware rejects the session)', async () => {
    const { token } = await invite('invitee@documind.test');
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [invitee.id]);
    expect((await accept({ token })).status).toBe(401);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
  });

  test('unauthenticated → 401', async () => {
    const { token } = await invite('invitee@documind.test');
    expect((await supertest(app).post('/api/invitations/accept').send({ token })).status).toBe(401);
  });
});
