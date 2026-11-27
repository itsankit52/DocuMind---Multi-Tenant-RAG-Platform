/**
 * F9 (P1) — every invalid invitation state answers preview AND accept identically.
 *
 * Unknown token, other email, revoked, accepted, expired, organization suspended, inviter
 * demoted, inviter account disabled and inviter deleted (invited_by NULL) must all produce the
 * same 404 status, body and headers (except per-response X-Request-Id / Date), never reveal
 * IDs, emails, the token or its hash, and grant nothing. Real PostgreSQL and Redis (DB 15).
 */

const { pool } = require('../../src/db');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, getInvite, clearOrgRateLimits, newToken, createUser, seedInviteWithToken,
  inconsistentAcceptedInvitations,
} = require('./invitation.helpers');

const INVALID = { status: 'fail', message: 'Invitation not found or no longer valid.' };
let orgA;
let orgB;
let invitee;

const accept = (token, userToken = invitee.token) => api(userToken).post('/api/invitations/accept').send({ token });
const preview = (token, userToken = invitee.token) => api(userToken).post('/api/invitations/preview').send({ token });

async function invite(email = 'invitee@documind.test', role = 'member', org = orgA) {
  const res = await api(org.users.admin.token).post(invitationsUrl(org.orgId)).send({ email, role });
  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  const { rows: [db] } = await pool.query('SELECT current_database() AS name');
  expect(db.name).toBe('documind_test');
});

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('acc-sec-a', ['admin', 'member']);
  orgB = await h.createOrgWithUsers('acc-sec-b', ['admin']);
  invitee = await createUser('invitee@documind.test');
});

afterEach(async () => {
  expect(await inconsistentAcceptedInvitations()).toEqual([]);
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

describe('Enumeration resistance', () => {
  test('every invalid invitation state is indistinguishable (body and headers), with nothing written', async () => {
    const HOUR = 3600 * 1000;
    const pending = { email: 'invitee@documind.test' };
    // Each state lives in its own organization where it would otherwise disturb the others.
    const orgSuspended = await h.createOrgWithUsers('acc-sec-susp', ['admin']);
    const orgDemoted = await h.createOrgWithUsers('acc-sec-demo', ['admin']);
    const orgDisabled = await h.createOrgWithUsers('acc-sec-disa', ['admin']);
    const orgNoInviter = await h.createOrgWithUsers('acc-sec-noinv', ['admin']); // one pending invite per org+email
    const seed = (org, fields = {}) => seedInviteWithToken({ organization_id: org.orgId, invited_by: org.users.admin.id, ...pending, ...fields });

    const cases = {
      unknown: { token: newToken(), row: null, expectedStatus: null },
      'other email': await invite('someone@documind.test'),
      revoked: await seed(orgA, { status: 'revoked', revoked_at: new Date() }),
      accepted: await seed(orgB, { status: 'accepted', accepted_at: new Date(), accepted_by: orgB.users.admin.id }),
      expired: await seed(orgA, { created_at: new Date(Date.now() - 100 * HOUR), expires_at: new Date(Date.now() - HOUR) }),
      'organization suspended': await seed(orgSuspended),
      'inviter demoted': await seed(orgDemoted),
      'inviter disabled': await seed(orgDisabled),
      'inviter deleted (invited_by NULL)': await seed(orgNoInviter, { invited_by: null }),
    };
    await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [orgSuspended.orgId]);
    await pool.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [orgDemoted.orgId, orgDemoted.users.admin.id]);
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [orgDisabled.users.admin.id]);

    const before = {};
    for (const [name, c] of Object.entries(cases)) {
      const id = c.row ? c.row.id : c.invitation && c.invitation.id;
      if (id) before[name] = { id, status: (await getInvite(id)).status };
    }

    // Headers that legitimately differ per response; everything else must be identical.
    const PER_RESPONSE = new Set(['x-request-id', 'date']);
    const shape = (res) => JSON.stringify({
      status: res.status,
      text: res.text,
      headers: Object.entries(res.headers).filter(([k]) => !PER_RESPONSE.has(k)).sort(),
    });
    const shapes = new Set();
    const ids = [orgA, orgB, orgSuspended, orgDemoted, orgDisabled, orgNoInviter].flatMap(o => [o.orgId, ...Object.values(o.users).map(u => u.id)]);
    for (const [name, c] of Object.entries(cases)) {
      for (const [kind, res] of [['preview', await preview(c.token)], ['accept', await accept(c.token)]]) {
        expect({ name, kind, status: res.status, body: res.body }).toEqual({ name, kind, status: 404, body: INVALID });
        shapes.add(shape(res));
        const everything = `${res.text}\n${JSON.stringify(res.headers)}`;
        for (const secret of [c.token, sha256(c.token), ...ids, ...Object.values(before).map(b => b.id), '@documind.test']) {
          expect({ name, kind, leaked: everything.includes(secret) }).toEqual({ name, kind, leaked: false });
        }
      }
    }
    expect(shapes.size).toBe(1);

    // Nothing granted anywhere; invitation states unchanged except the documented
    // pending → expired transition that acceptance commits for an overdue invitation.
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM memberships WHERE user_id = $1', [invitee.id]);
    expect(n).toBe(0);
    for (const [name, b] of Object.entries(before)) {
      const expected = name === 'expired' ? 'expired' : b.status;
      expect({ name, status: (await getInvite(b.id)).status }).toEqual({ name, status: expected });
    }
    expect(await pool.query("SELECT 1 FROM audit_logs WHERE action = 'INVITATION_ACCEPT'").then(r => r.rowCount)).toBe(0);
  });
});
