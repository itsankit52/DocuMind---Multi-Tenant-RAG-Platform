/**
 * Google sign-in: flow, state, account creation/linking cases A–D, session, security.
 * documind_test + Redis test DB only (test guard). Google is never called (fake client).
 */

const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { pool } = require('../../src/db');
const oauthRepo = require('../../src/repositories/oauth.repository');
const logger = require('../../src/observability/logger');
const oauthState = require('../../src/auth/oauth-state');
const h = require('./google.helpers');
const sh = require('../streaming/stream.helpers');

let fake;
let redis;
const G = (sub, email, extra = {}) => ({ sub, email, name: `Name ${sub}`, picture: `https://lh3.googleusercontent.com/${sub}`, ...extra });

beforeAll(async () => { await sh.truncateAll(); h.enableGoogle(); });
beforeEach(async () => { fake = h.fakeClient(); redis = await h.clearRedis(); });
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { h.restoreGoogle(); await sh.truncateAll(); await h.clearRedis(); await pool.end(); });

describe('initiation and state', () => {
  test('redirects to Google with state, nonce and an S256 PKCE challenge; sets an HttpOnly Lax binding cookie', async () => {
    const { res, call } = await h.start(app, undefined, fake);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(call.scope).toEqual(['openid', 'email', 'profile']);
    expect(call.code_challenge_method).toBe('S256');
    expect(call.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(call.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const cookie = res.headers['set-cookie'].find(c => c.startsWith('documind_oauth_binding='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/google/);
    expect(res.headers['cache-control']).toBe('no-store');
    // stored under the hash of the state, never the raw value; TTL bounded
    const keys = await redis.keys('oauth:google:state:*');
    expect(keys).toEqual([`oauth:google:state:${oauthState.sha256(call.state)}`]);
    expect(JSON.stringify(await redis.get(keys[0]))).not.toContain(call.state);
    expect(await redis.ttl(keys[0])).toBeGreaterThan(500);
  });

  test('every flow gets fresh random state, nonce and verifier', async () => {
    await h.start(app, undefined, fake);
    await h.start(app, undefined, fake);
    const [a, b] = fake.authCalls;
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.code_challenge).not.toBe(b.code_challenge);
  });

  test('unknown, missing, expired and reused states are refused; Google is not called', async () => {
    const agent = supertest.agent(app);
    expect(h.outcome(await agent.get('/api/auth/google/callback?code=x'))).toEqual({ error: 'invalid_state' });
    expect(h.outcome(await agent.get('/api/auth/google/callback?state=unknown&code=x'))).toEqual({ error: 'expired_state' });

    const expired = await h.start(app, agent, fake);
    await redis.del(`oauth:google:state:${oauthState.sha256(expired.state)}`); // TTL elapsed
    expect(h.outcome(await agent.get(`/api/auth/google/callback?state=${expired.state}&code=x`))).toEqual({ error: 'expired_state' });

    const { res, state, code } = await h.roundTrip(app, fake, G('reuse-1', 'reuse@example.com'));
    expect(h.outcome(res)).toEqual({ status: 'signed_up' });
    const again = await supertest(app).get(`/api/auth/google/callback?state=${state}&code=${code}`);
    expect(h.outcome(again)).toEqual({ error: 'expired_state' });
    expect(fake.tokenCalls).toHaveLength(1); // the code was exchanged once
  });

  test('a state from another browser (no or wrong binding cookie) is refused and burned', async () => {
    const { state } = await h.start(app, undefined, fake);
    fake.identities.set('c1', G('csrf-1', 'csrf@example.com'));
    const other = await supertest(app).get(`/api/auth/google/callback?state=${state}&code=c1`);
    expect(h.outcome(other)).toEqual({ error: 'invalid_state' });
    expect(await redis.keys('oauth:google:state:*')).toEqual([]);
    expect(fake.tokenCalls).toHaveLength(0);
    expect(await h.usersByEmail('csrf@example.com')).toEqual([]);
  });

  test('missing code, cancellation and Google errors', async () => {
    const a = await h.start(app, undefined, fake);
    expect(h.outcome(await a.agent.get(`/api/auth/google/callback?state=${a.state}`))).toEqual({ error: 'invalid_request' });
    const b = await h.start(app, undefined, fake);
    expect(h.outcome(await b.agent.get(`/api/auth/google/callback?state=${b.state}&error=access_denied`))).toEqual({ error: 'cancelled' });
    const c = await h.start(app, undefined, fake);
    expect(h.outcome(await c.agent.get(`/api/auth/google/callback?state=${c.state}&error=server_error`))).toEqual({ error: 'google_error' });
  });

  test('code exchange and ID-token verification failures', async () => {
    const s = await h.start(app, undefined, fake);
    expect(h.outcome(await s.agent.get(`/api/auth/google/callback?state=${s.state}&code=bad-code`))).toEqual({ error: 'code_exchange_failed' });
    expect(h.outcome((await h.roundTrip(app, fake, new Error('bad signature'))).res)).toEqual({ error: 'id_token_invalid' });
    expect(h.outcome((await h.roundTrip(app, fake, G('n-1', 'nonce@example.com', { nonce: 'other' }))).res)).toEqual({ error: 'id_token_invalid' });
    expect(h.outcome((await h.roundTrip(app, fake, G('u-1', 'unverified@example.com', { email_verified: false }))).res)).toEqual({ error: 'email_unverified' });
    expect(await h.usersByEmail('unverified@example.com')).toEqual([]);
  });

  test('not configured: a clear error, no redirect to Google', async () => {
    env.GOOGLE_OAUTH_ENABLED = false;
    try {
      expect(h.outcome(await supertest(app).get('/api/auth/google'))).toEqual({ error: 'not_configured' });
      expect(fake.authCalls).toHaveLength(0);
    } finally { env.GOOGLE_OAUTH_ENABLED = true; }
  });

  test('Redis unavailable at start: fails closed with a safe error', async () => {
    jest.spyOn(oauthState, 'saveState').mockRejectedValue(new Error('redis down'));
    expect(h.outcome(await supertest(app).get('/api/auth/google'))).toEqual({ error: 'unavailable' });
  });
});

describe('accounts', () => {
  test('A: new Google user → user without password + link, application session, no organization', async () => {
    const { res, agent } = await h.roundTrip(app, fake, G('new-1', 'New.User@Example.com'));
    expect(h.outcome(res)).toEqual({ status: 'signed_up' });
    const [user] = await h.usersByEmail('new.user@example.com');
    expect(user).toMatchObject({ email: 'new.user@example.com', full_name: 'Name new-1', password_hash: null, status: 'active',
      avatar_url: 'https://lh3.googleusercontent.com/new-1' });
    expect(await h.linksFor(user.id)).toEqual([{ provider: 'google', provider_user_id: 'new-1' }]);
    expect((await pool.query('SELECT count(*)::int AS n FROM memberships WHERE user_id = $1', [user.id])).rows[0].n).toBe(0);

    // the same session as password login: HttpOnly Strict cookies with the normal JWT
    const cookies = res.headers['set-cookie'];
    const access = cookies.find(c => c.startsWith('accessToken='));
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Strict/i);
    expect(cookies.find(c => c.startsWith('refreshToken='))).toMatch(/HttpOnly/i);
    const decoded = jwt.verify(access.split(';')[0].split('=')[1], env.JWT_ACCESS_SECRET);
    expect(Object.keys(decoded).sort()).toEqual(['exp', 'iat', 'userId']);
    expect(decoded.userId).toBe(user.id);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ id: user.id, email: 'new.user@example.com', authMethods: { password: false, google: true } });
    expect(me.body.data.organizations).toEqual([]);
    // no Google token in any response or cookie
    expect(JSON.stringify(res.headers)).not.toMatch(/ya29|idtoken-for/);
  });

  test('B: returning Google user → same user, no duplicate, avatar refreshed, name and email kept', async () => {
    await h.roundTrip(app, fake, G('ret-1', 'returning@example.com'));
    const [before] = await h.usersByEmail('returning@example.com');
    await pool.query("UPDATE users SET full_name = 'Chosen Name' WHERE id = $1", [before.id]);
    const { res } = await h.roundTrip(app, fake, G('ret-1', 'returning@example.com', { name: 'Google Name', picture: 'https://lh3.googleusercontent.com/new' }));
    expect(h.outcome(res)).toEqual({ status: 'signed_in' });
    const after = await h.usersByEmail('returning@example.com');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, full_name: 'Chosen Name', avatar_url: 'https://lh3.googleusercontent.com/new' });
  });

  test('C: email of an existing password account → refused, nothing linked, no session', async () => {
    const o = await sh.createOrgWithUsers('gx', ['admin']); // gx_admin@documind.test with a password
    const { res } = await h.roundTrip(app, fake, G('c-1', 'GX_Admin@documind.test'));
    expect(h.outcome(res)).toEqual({ error: 'account_exists' });
    expect(h.cookieNames(res)).not.toContain('accessToken');
    expect(await h.linksFor(o.users.admin.id)).toEqual([]);
    expect(await h.usersByEmail('gx_admin@documind.test')).toHaveLength(1);
  });

  test('D: linked identity whose email now belongs to another account → refused, nothing transferred, logged without PII', async () => {
    await h.roundTrip(app, fake, G('d-1', 'first@example.com'));
    await h.roundTrip(app, fake, G('d-2', 'second@example.com'));
    const warn = jest.spyOn(logger, 'warn');
    const { res } = await h.roundTrip(app, fake, G('d-1', 'second@example.com'));
    expect(h.outcome(res)).toEqual({ error: 'account_conflict' });
    const [first] = await h.usersByEmail('first@example.com');
    expect(await h.linksFor(first.id)).toEqual([{ provider: 'google', provider_user_id: 'd-1' }]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('oauth_email_conflict');
    expect(logged).not.toMatch(/second@example\.com|first@example\.com|d-1/);
  });

  test('disabled accounts cannot sign in with Google', async () => {
    await h.roundTrip(app, fake, G('dis-1', 'disabled@example.com'));
    await pool.query("UPDATE users SET status = 'disabled' WHERE lower(email) = 'disabled@example.com'");
    const { res } = await h.roundTrip(app, fake, G('dis-1', 'disabled@example.com'));
    expect(h.outcome(res)).toEqual({ error: 'account_disabled' });
    expect(h.cookieNames(res)).not.toContain('accessToken');
  });

  test('concurrent first sign-ins with the same identity create exactly one user', async () => {
    const a = await h.start(app, undefined, fake);
    const b = await h.start(app, undefined, fake);
    fake.identities.set('ra', G('race-1', 'race@example.com', { nonce: a.call.nonce }));
    fake.identities.set('rb', G('race-1', 'race@example.com', { nonce: b.call.nonce }));
    const [ra, rb] = await Promise.all([
      a.agent.get(`/api/auth/google/callback?state=${a.state}&code=ra`),
      b.agent.get(`/api/auth/google/callback?state=${b.state}&code=rb`),
    ]);
    expect([h.outcome(ra).status, h.outcome(rb).status].sort()).toEqual(['signed_in', 'signed_up']);
    expect(await h.usersByEmail('race@example.com')).toHaveLength(1);
  });

  test('user creation and the identity link are atomic (rollback)', async () => {
    jest.spyOn(oauthRepo, 'linkProvider').mockRejectedValueOnce(new Error('insert failed'));
    const { res } = await h.roundTrip(app, fake, G('rb-1', 'rollback@example.com'));
    expect(h.outcome(res)).toEqual({ error: 'server_error' });
    expect(await h.usersByEmail('rollback@example.com')).toEqual([]);
  });

  test('a Google-only account cannot sign in with a password (401, not 500)', async () => {
    await h.roundTrip(app, fake, G('pw-1', 'nopassword@example.com'));
    const res = await supertest(app).post('/api/auth/login').send({ email: 'nopassword@example.com', password: 'whatever123' });
    expect(res.status).toBe(401);
  });
});

describe('explicit account linking', () => {
  const login = async (email) => {
    const agent = supertest.agent(app);
    expect((await agent.post('/api/auth/login').send({ email, password: 'Password123!' })).status).toBe(200);
    return agent;
  };
  const link = async (agent, payload, password = 'Password123!') => {
    const res = await agent.post('/api/auth/google/link').send({ password });
    if (res.status !== 200) return { linkRes: res };
    const call = fake.authCalls[fake.authCalls.length - 1];
    expect(res.body.data.url).toMatch(/^https:\/\/accounts\.google\.com\//);
    fake.identities.set('lc', { nonce: call.nonce, ...payload });
    return { linkRes: res, res: await agent.get(`/api/auth/google/callback?state=${call.state}&code=lc`) };
  };

  test('requires a session and the current password', async () => {
    await sh.createOrgWithUsers('lk1', ['admin']);
    expect((await supertest(app).post('/api/auth/google/link').send({ password: 'x' })).status).toBe(401);
    const agent = await login('lk1_admin@documind.test');
    expect((await agent.post('/api/auth/google/link').send({ password: 'wrong-password' })).status).toBe(401);
    expect((await agent.post('/api/auth/google/link').send({ password: 'x', userId: 'someone' })).status).toBe(400);
    expect(fake.authCalls).toHaveLength(0);
  });

  test('links after re-authentication; afterwards Google signs in to the same account', async () => {
    const o = await sh.createOrgWithUsers('lk2', ['admin']);
    const agent = await login('lk2_admin@documind.test');
    const { res } = await link(agent, G('lk-2', 'LK2_admin@documind.test'));
    expect(h.outcome(res)).toEqual({ status: 'linked' });
    expect(await h.linksFor(o.users.admin.id)).toEqual([{ provider: 'google', provider_user_id: 'lk-2' }]);
    const { res: signIn, agent: g } = await h.roundTrip(app, fake, G('lk-2', 'lk2_admin@documind.test'));
    expect(h.outcome(signIn)).toEqual({ status: 'signed_in' });
    const me = await g.get('/api/auth/me');
    expect(me.body.data.user.id).toBe(o.users.admin.id);
    expect(me.body.data.organizations.map(x => x.organization_id)).toEqual([o.orgId]); // memberships unchanged
    expect((await agent.post('/api/auth/google/link').send({ password: 'Password123!' })).status).toBe(409);
  });

  test('refuses a different Google email and a Google identity linked to someone else', async () => {
    await sh.createOrgWithUsers('lk3', ['admin']);
    const agent = await login('lk3_admin@documind.test');
    expect(h.outcome((await link(agent, G('lk-3', 'someone.else@example.com'))).res)).toEqual({ error: 'email_mismatch' });

    await h.roundTrip(app, fake, G('taken-1', 'taken@example.com')); // identity owned by another user
    expect(h.outcome((await link(agent, G('taken-1', 'lk3_admin@documind.test'))).res)).toEqual({ error: 'google_account_in_use' });
    const [me] = await h.usersByEmail('lk3_admin@documind.test');
    expect(await h.linksFor(me.id)).toEqual([]);
  });
});

describe('security', () => {
  test('identity in the browser request is ignored: only the verified token counts', async () => {
    const victim = await sh.createOrgWithUsers('victim', ['admin']);
    const s = await h.start(app, undefined, fake);
    fake.identities.set('sx', G('attacker-1', 'attacker@example.com', { nonce: s.call.nonce }));
    const res = await s.agent.get(`/api/auth/google/callback?state=${s.state}&code=sx&email=victim_admin@documind.test&sub=x&userId=${victim.users.admin.id}`);
    expect(h.outcome(res)).toEqual({ status: 'signed_up' });
    const me = await s.agent.get('/api/auth/me');
    expect(me.body.data.user.email).toBe('attacker@example.com');
    expect(await h.linksFor(victim.users.admin.id)).toEqual([]);
  });

  test('every callback redirect goes to APP_BASE_URL/auth/google/complete, whatever the request says', async () => {
    const s = await h.start(app, undefined, fake);
    fake.identities.set('rd', G('rd-1', 'redirect@example.com', { nonce: s.call.nonce }));
    const res = await s.agent.get(`/api/auth/google/callback?state=${s.state}&code=rd&redirect_uri=https://evil.example&returnTo=//evil.example`)
      .set('Host', 'evil.example').set('X-Forwarded-Host', 'evil.example');
    expect(res.headers.location).toBe(`${h.COMPLETE}status=signed_up`);
  });

  test('codes, states, tokens and emails never reach logs or the completion URL', async () => {
    const spies = ['info', 'warn', 'error', 'debug'].map(l => jest.spyOn(logger, l));
    const { res, state, code } = await h.roundTrip(app, fake, G('log-1', 'logcheck@example.com'));
    await h.roundTrip(app, fake, new Error('bad token'));
    const logged = JSON.stringify(spies.map(s => s.mock.calls));
    for (const secret of [state, code, `idtoken-for-${code}`, 'ya29', 'logcheck@example.com', 'test-client-secret']) {
      expect(logged).not.toContain(secret);
      expect(res.headers.location).not.toContain(secret);
    }
  });
});
