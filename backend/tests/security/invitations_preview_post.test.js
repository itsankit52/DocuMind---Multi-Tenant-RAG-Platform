/**
 * Phase 3.2C (F3) — invitation preview is POST /api/invitations/preview with { token } in
 * the JSON body. The token must never travel in a URL: URLs reach proxy access/error logs
 * (Nginx error entries include the full request line), browser history and Referer headers.
 *
 * Behavioural cases (valid, unknown, expired, revoked, accepted, inactive org/inviter, email
 * mismatch, validation, unauthenticated) run through the POST contract in
 * invitations_accept.test.js. This file covers the transport contract and leakage.
 * Synthetic tokens only; values are never printed.
 */

const supertest = require('supertest');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const logger = require('../../src/observability/logger');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, clearOrgRateLimits, newToken, createUser, seedInviteWithToken, getInvite,
} = require('./invitation.helpers');

const INVALID = { status: 'fail', message: 'Invitation not found or no longer valid.' };
const QUERY_REJECTED = {
  status: 'fail', message: 'Query parameters are not accepted. Send the invitation token in the request body.',
};
let orgA;
let invitee;

const post = (body, userToken = invitee.token, query = '') =>
  api(userToken).post(`/api/invitations/preview${query}`).send(body);

async function invite(email = 'invitee@documind.test', role = 'viewer') {
  const res = await api(orgA.users.admin.token).post(invitationsUrl(orgA.orgId)).send({ email, role });
  expect(res.status).toBe(201);
  return res.body.data;
}

/** Nothing derived from the token appears in the response body or headers. */
function expectNoTokenInResponse(res, token) {
  const everything = `${res.text}\n${JSON.stringify(res.headers)}`;
  for (const form of [token, encodeURIComponent(token), sha256(token)]) expect(everything.includes(form)).toBe(false);
}

const expectSensitiveHeaders = (res) => {
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
};

beforeAll(async () => {
  const { rows: [db] } = await pool.query('SELECT current_database() AS name');
  expect(db.name).toBe('documind_test');
});

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('prev-a', ['admin']);
  invitee = await createUser('invitee@documind.test', { fullName: 'Ivy Invitee' });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

describe('POST /api/invitations/preview — contract', () => {
  test('valid token in the body → 200 with the same preview fields as before', async () => {
    const { token } = await invite();
    const res = await post({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'success',
      data: { invitation: { organizationName: expect.any(String), role: 'viewer', inviterName: expect.any(String), expiresAt: expect.any(String) } },
    });
    expectSensitiveHeaders(res);
    expectNoTokenInResponse(res, token);
  });

  test('preview does not change the invitation (read-only)', async () => {
    const { row, token } = await seedInviteWithToken({
      organization_id: orgA.orgId, email: 'invitee@documind.test', invited_by: orgA.users.admin.id,
    });
    expect((await post({ token })).status).toBe(200);
    expect((await getInvite(row.id)).status).toBe('pending');
  });

  test.each([
    ['missing body', undefined],
    ['empty object', {}],
    ['empty token', { token: '' }],
    ['null token', { token: null }],
    ['numeric token', { token: 12345 }],
    ['array token', { token: [newToken()] }],
    ['malformed token', { token: 'not a token!' }],
    ['too short', { token: 'A'.repeat(42) }],
    ['too long', { token: 'A'.repeat(44) }],
    ['very long', { token: 'A'.repeat(10000) }],
  ])('%s → 400, sensitive headers kept', async (_label, body) => {
    const res = await (body === undefined ? api(invitee.token).post('/api/invitations/preview') : post(body));
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('fail');
    expectSensitiveHeaders(res);
  });

  test.each([
    ['organizationId', (t) => ({ token: t, organizationId: orgA.orgId })],
    ['role', (t) => ({ token: t, role: 'admin' })],
    ['email', (t) => ({ token: t, email: 'invitee@documind.test' })],
    ['status', (t) => ({ token: t, status: 'pending' })],
    ['userId', (t) => ({ token: t, userId: invitee.id })],
  ])('client-supplied %s is rejected, never interpreted (strict body)', async (_label, build) => {
    const { token } = await invite();
    const res = await post(build(token));
    expect(res.status).toBe(400);
    expectNoTokenInResponse(res, token);
  });

  test('a non-JSON body is not accepted as a token source', async () => {
    const { token } = await invite();
    const form = await api(invitee.token).post('/api/invitations/preview').type('form').send(`token=${token}`);
    expect(form.status).toBe(400);
    const text = await api(invitee.token).post('/api/invitations/preview').set('Content-Type', 'text/plain').send(token);
    expect(text.status).toBe(400);
    expectNoTokenInResponse(form, token);
    expectNoTokenInResponse(text, token);
  });

  test('an unknown well-formed token → the existing generic 404', async () => {
    const token = newToken();
    const res = await post({ token });
    expect(res.status).toBe(404);
    expect(res.body).toEqual(INVALID);
    expectSensitiveHeaders(res);
    expectNoTokenInResponse(res, token);
  });

  test('unauthenticated → 401 (auth middleware still in front)', async () => {
    const { token } = await invite();
    const res = await supertest(app).post('/api/invitations/preview').send({ token });
    expect(res.status).toBe(401);
    expectNoTokenInResponse(res, token);
  });

  test('rate limiting still applies (60 / 15 min per user)', async () => {
    const token = newToken();
    for (let i = 0; i < 60; i += 1) expect((await post({ token })).status).toBe(404);
    const limited = await post({ token });
    expect(limited.status).toBe(429);
    expectNoTokenInResponse(limited, token);
  });
});

describe('the token is never accepted from a URL', () => {
  test('query-string token is rejected with 400 (not echoed), even alongside a valid body', async () => {
    const { token } = await invite();
    const onlyQuery = await post({}, invitee.token, `?token=${token}`);
    const both = await post({ token }, invitee.token, `?token=${token}`);
    const otherParam = await post({ token }, invitee.token, '?x=1');
    for (const res of [onlyQuery, both, otherParam]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual(QUERY_REJECTED);
      expectSensitiveHeaders(res);
      expectNoTokenInResponse(res, token);
    }
  });

  test('the legacy GET /preview?token= route is gone: path-only 404, nothing resolved or echoed', async () => {
    const { token } = await invite();
    const res = await api(invitee.token).get(`/api/invitations/preview?token=${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'fail', message: "Can't find /api/invitations/preview on this server!" });
    expect(JSON.stringify(res.body)).not.toContain('organizationName');
    expectNoTokenInResponse(res, token);
  });
});

describe('logs', () => {
  test('raw tokens and hashes never reach application logs (success, invalid, query, GET, 500)', async () => {
    const lines = [];
    const previousLevel = logger.getLevel();
    logger.configure({ level: 'debug', write: (line) => lines.push(line) });
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(m =>
      jest.spyOn(console, m).mockImplementation((...args) => lines.push(args.map(String).join(' '))));
    const { token } = await invite();
    const unknown = newToken();
    try {
      expect((await post({ token })).status).toBe(200);
      expect((await post({ token: unknown })).status).toBe(404);
      expect((await post({ token }, invitee.token, `?token=${token}`)).status).toBe(400);
      expect((await api(invitee.token).get(`/api/invitations/preview?token=${token}`)).status).toBe(404);
      const service = require('../../src/invitations/invitation.service');
      jest.spyOn(service, 'previewInvitation').mockRejectedValueOnce(new Error('db exploded'));
      const failed = await post({ token });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ status: 'error', message: 'Internal server error' }); // existing AppError.from wrapping
      expect(failed.text).not.toContain('db exploded');
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const secret of [token, sha256(token), unknown, sha256(unknown)]) expect(all.includes(secret)).toBe(false);
    } finally {
      consoleSpies.forEach(s => s.mockRestore());
      logger.configure({ level: previousLevel });
    }
  });
});
