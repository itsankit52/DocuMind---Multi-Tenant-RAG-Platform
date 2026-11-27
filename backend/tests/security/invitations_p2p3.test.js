/**
 * Phase 3.3 WP2 (F9 P2/P3) — invitation tests not covered by the existing suites:
 *  1. server-controlled fields cannot be supplied by the client (create, resend, revoke,
 *     preview, accept);
 *  2. an admin demoted or removed AFTER being authorized keeps a valid JWT but loses every
 *     invitation admin action;
 *  3. truly concurrent requests from two tenants over the shared pool never see each
 *     other's data (tenant context cannot leak between concurrent transactions).
 * Real PostgreSQL (documind_test) and Redis DB 15; no sleeps.
 */

const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, invitationUrl, seedInvite, getInvite, countInvites,
  clearOrgRateLimits, createUser, seedInviteWithToken, membershipOf,
} = require('./invitation.helpers');

const HOURS_72 = 72 * 3600 * 1000;
let orgA;
let orgB;
const asA = (role = 'admin') => api(orgA.users[role].token);
const near72h = (date) => Math.abs(new Date(date).getTime() - (Date.now() + HOURS_72)) < 60 * 1000;

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('p23-a', ['admin', 'member']);
  orgB = await h.createOrgWithUsers('p23-b', ['admin']);
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

describe('1. server-controlled fields cannot be overridden by the client', () => {
  const FORGED_TOKEN = 'F'.repeat(43);
  const forged = () => ({
    organizationId: orgB.orgId, organization_id: orgB.orgId, actorId: orgB.users.admin.id,
    invited_by: orgB.users.admin.id, status: 'accepted', token: FORGED_TOKEN, token_hash: sha256(FORGED_TOKEN),
    expires_at: '2099-01-01T00:00:00Z', accepted_by: orgB.users.admin.id, id: '00000000-0000-4000-8000-000000000001',
  });

  test('create: only email and role are taken from the body', async () => {
    const res = await asA().post(invitationsUrl(orgA.orgId)).send({ email: 'mass@documind.test', role: 'viewer', ...forged() });
    expect(res.status).toBe(201);
    const { invitation, token } = res.body.data;
    expect(invitation).toMatchObject({
      organization_id: orgA.orgId, invited_by: orgA.users.admin.id, status: 'pending',
      accepted_by: null, email: 'mass@documind.test', role: 'viewer',
    });
    expect(invitation.id).not.toBe(forged().id);
    expect(token).not.toBe(FORGED_TOKEN);
    const row = await getInvite(invitation.id);
    expect(row.token_hash).toBe(sha256(token));
    expect(near72h(row.expires_at)).toBe(true);
    expect(await countInvites('organization_id = $1', [orgB.orgId])).toBe(0);
  });

  test('resend and revoke ignore body fields entirely', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId, invited_by: orgA.users.admin.id });
    const resend = await asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`).send(forged());
    expect(resend.status).toBe(200);
    expect(resend.body.data.token).not.toBe(FORGED_TOKEN);
    let row = await getInvite(inv.id);
    expect(row).toMatchObject({ organization_id: orgA.orgId, status: 'pending', accepted_by: null });
    expect(row.token_hash).toBe(sha256(resend.body.data.token));
    expect(near72h(row.expires_at)).toBe(true);

    const revoke = await asA().delete(invitationUrl(orgA.orgId, inv.id)).send({ status: 'pending', ...forged() });
    expect(revoke.status).toBe(200);
    row = await getInvite(inv.id);
    expect(row).toMatchObject({ status: 'revoked', revoked_by: orgA.users.admin.id, organization_id: orgA.orgId });
  });

  test.each([
    ['role', 'admin'], ['organizationId', 'B'], ['status', 'accepted'], ['email', 'other@documind.test'],
  ])('preview and accept reject an extra %p field (400) and change nothing', async (field, value) => {
    const invitee = await createUser('p23-invitee@documind.test');
    const { row, token } = await seedInviteWithToken({
      organization_id: orgA.orgId, invited_by: orgA.users.admin.id, email: invitee.email, role: 'viewer',
    });
    const extra = { [field]: value === 'B' ? orgB.orgId : value };
    for (const path of ['/api/invitations/preview', '/api/invitations/accept']) {
      const res = await api(invitee.token).post(path).send({ token, ...extra });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(token);
    }
    expect((await getInvite(row.id)).status).toBe('pending');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    expect(await membershipOf(orgB.orgId, invitee.id)).toEqual([]);
    // positive control: the same token without the extra field is accepted with the INVITED role
    expect((await api(invitee.token).post('/api/invitations/accept').send({ token })).status).toBe(200);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'viewer', status: 'active' })]);
  });
});

describe('2. authorization is re-evaluated on every request', () => {
  const memberEmail = 'p23-a_member@documind.test';

  async function promotedThenInvite() {
    const promote = await asA().post(`/api/organizations/${orgA.orgId}/members`).send({ email: memberEmail, role: 'admin' });
    expect(promote.status).toBeLessThan(300);
    const created = await asA('member').post(invitationsUrl(orgA.orgId)).send({ email: 'by-promoted@documind.test', role: 'member' });
    expect(created.status).toBe(201); // authorized while admin
    return created.body.data.invitation;
  }

  async function expectNoAdminActions(inv) {
    const before = await getInvite(inv.id);
    const user = asA('member'); // the SAME, still-valid JWT
    expect((await user.post(invitationsUrl(orgA.orgId)).send({ email: 'after@documind.test', role: 'member' })).status).toBe(403);
    expect((await user.get(invitationsUrl(orgA.orgId))).status).toBe(403);
    expect((await user.post(`${invitationUrl(orgA.orgId, inv.id)}/resend`)).status).toBe(403);
    expect((await user.delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(403);
    const after = await getInvite(inv.id);
    expect(after).toEqual(before); // token, status and expiry untouched
    expect(await countInvites('email = $1', ['after@documind.test'])).toBe(0);
  }

  test('demoted through the real members API → 403 on create, list, resend and revoke', async () => {
    const inv = await promotedThenInvite();
    const demote = await asA().post(`/api/organizations/${orgA.orgId}/members`).send({ email: memberEmail, role: 'viewer' });
    expect(demote.status).toBeLessThan(300);
    await expectNoAdminActions(inv);
  });

  test('membership removed (status) after authorization → 403 on every admin action', async () => {
    const inv = await promotedThenInvite();
    await pool.query("UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2",
      [orgA.orgId, orgA.users.member.id]);
    await expectNoAdminActions(inv);
  });
});

describe('3. concurrent cross-tenant requests never leak tenant context', () => {
  test('40 interleaved, concurrent list and preview requests each see only their own organization', async () => {
    const idsA = new Set();
    const idsB = new Set();
    for (let i = 0; i < 3; i++) idsA.add((await seedInvite({ organization_id: orgA.orgId, invited_by: orgA.users.admin.id })).id);
    for (let i = 0; i < 2; i++) idsB.add((await seedInvite({ organization_id: orgB.orgId, invited_by: orgB.users.admin.id })).id);
    const inviteeA = await createUser('p23-conc-a@documind.test');
    const inviteeB = await createUser('p23-conc-b@documind.test');
    const tokA = (await seedInviteWithToken({ organization_id: orgA.orgId, invited_by: orgA.users.admin.id, email: inviteeA.email })).token;
    const tokB = (await seedInviteWithToken({ organization_id: orgB.orgId, invited_by: orgB.users.admin.id, email: inviteeB.email })).token;
    // the pending invitations of each invitee are part of each organization's list
    const { rows } = await pool.query('SELECT id, organization_id FROM organization_invitations WHERE email = ANY($1)', [[inviteeA.email, inviteeB.email]]);
    for (const r of rows) (r.organization_id === orgA.orgId ? idsA : idsB).add(r.id);

    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(['listA', api(orgA.users.admin.token).get(invitationsUrl(orgA.orgId))]);
      jobs.push(['listB', api(orgB.users.admin.token).get(invitationsUrl(orgB.orgId))]);
      jobs.push(['prevA', api(inviteeA.token).post('/api/invitations/preview').send({ token: tokA })]);
      jobs.push(['prevB', api(inviteeB.token).post('/api/invitations/preview').send({ token: tokB })]);
    }
    const results = await Promise.all(jobs.map(([kind, req]) => req.then(res => [kind, res])));

    for (const [kind, res] of results) {
      expect(res.status).toBe(200);
      if (kind === 'listA') expect(new Set(res.body.data.invitations.map(i => i.id))).toEqual(idsA);
      if (kind === 'listB') expect(new Set(res.body.data.invitations.map(i => i.id))).toEqual(idsB);
      if (kind === 'prevA') expect(res.body.data.invitation.organizationName).toBe('Org p23-a');
      if (kind === 'prevB') expect(res.body.data.invitation.organizationName).toBe('Org p23-b');
    }
    // the requests really ran over several pooled connections at once
    expect(pool.totalCount).toBeGreaterThan(1);
    // and no connection was returned to the pool with a role or tenant still set
    const clients = await Promise.all(Array.from({ length: pool.totalCount }, () => pool.connect()));
    try {
      for (const c of clients) {
        const { rows: [s] } = await c.query(
          "SELECT current_user = session_user AS same_role, coalesce(current_setting($1, true), '') AS tenant", [env.PG_TENANT_SETTING]);
        expect(s).toEqual({ same_role: true, tenant: '' });
      }
    } finally {
      clients.forEach(c => c.release());
    }
  });
});
