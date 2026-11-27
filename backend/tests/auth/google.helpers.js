/**
 * Test helpers for Google sign-in. No request ever reaches Google: a fake OAuth2Client records
 * the authorization-URL options (state, nonce, PKCE challenge) and returns a scripted identity
 * from verifyIdToken. Real ID-token verification is covered in google_id_token.test.js.
 */

const crypto = require('crypto');
const supertest = require('supertest');
const env = require('../../src/config/env');
const google = require('../../src/auth/google.oauth');
const { pool } = require('../../src/db');
const { getRedisClient } = require('../../src/middleware/rate-limiter');

const APP_BASE = 'http://app.documind.test';
const COMPLETE = `${APP_BASE}/auth/google/complete?`;
const ORIGINAL = {};
const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL', 'APP_BASE_URL', 'GOOGLE_OAUTH_ENABLED'];

function enableGoogle() {
  for (const k of KEYS) ORIGINAL[k] = env[k];
  Object.assign(env, {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback',
    APP_BASE_URL: APP_BASE,
    GOOGLE_OAUTH_ENABLED: true,
  });
}
function restoreGoogle() { for (const k of KEYS) env[k] = ORIGINAL[k]; google.setClientForTests(null); }

/** Fake Google client. `identity` (per code) drives what the verified ID token contains. */
function fakeClient() {
  const fake = {
    authCalls: [],
    tokenCalls: [],
    identities: new Map(), // code → payload overrides, or an Error to throw from verifyIdToken
    generateAuthUrl(opts) {
      fake.authCalls.push(opts);
      return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state: opts.state, client_id: 'x' })}`;
    },
    async getToken({ code, codeVerifier }) {
      fake.tokenCalls.push({ code, codeVerifier });
      if (code === 'bad-code') throw new Error('invalid_grant');
      return { tokens: { id_token: `idtoken-for-${code}`, access_token: 'ya29.secret-access' } };
    },
    async verifyIdToken({ idToken, audience }) {
      const code = idToken.replace('idtoken-for-', '');
      const p = fake.identities.get(code);
      if (p instanceof Error) throw p;
      const last = fake.authCalls[fake.authCalls.length - 1];
      return { getPayload: () => ({ iss: 'https://accounts.google.com', aud: audience, nonce: last && last.nonce,
        email_verified: true, ...p }) };
    },
  };
  google.setClientForTests(fake);
  return fake;
}

/** Start a flow with an agent (keeps the binding cookie); returns { agent, state, res }. */
async function start(app, agent = supertest.agent(app), fake) {
  const res = await agent.get('/api/auth/google');
  const call = fake.authCalls[fake.authCalls.length - 1];
  return { agent, res, state: call && call.state, call };
}

/** Full round trip: start + callback with `code` whose identity is `payload`. */
async function roundTrip(app, fake, payload, { code = crypto.randomUUID(), agent } = {}) {
  const s = await start(app, agent, fake);
  // the verified token carries the nonce of THIS flow unless the test overrides it
  fake.identities.set(code, payload instanceof Error ? payload : { nonce: s.call && s.call.nonce, ...payload });
  const res = await s.agent.get(`/api/auth/google/callback?state=${encodeURIComponent(s.state)}&code=${code}`);
  return { ...s, res, code };
}

const outcome = (res) => {
  const loc = res.headers.location || '';
  if (!loc.startsWith(COMPLETE)) return { invalidLocation: loc };
  return Object.fromEntries(new URLSearchParams(loc.slice(COMPLETE.length)));
};

const cookieNames = (res) => (res.headers['set-cookie'] || []).map(c => c.split('=')[0]);

async function clearRedis() {
  const redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
  const keys = [...await redis.keys('oauth:google:state:*'), ...await redis.keys('ratelimit:auth*')];
  if (keys.length) await redis.del(keys);
  return redis;
}

const usersByEmail = async (email) => (await pool.query(
  'SELECT id, email, full_name, avatar_url, password_hash, status FROM users WHERE lower(email) = lower($1)', [email])).rows;
const linksFor = async (userId) => (await pool.query(
  'SELECT provider, provider_user_id FROM oauth_accounts WHERE user_id = $1', [userId])).rows;

module.exports = { APP_BASE, COMPLETE, enableGoogle, restoreGoogle, fakeClient, start, roundTrip, outcome, cookieNames, clearRedis, usersByEmail, linksFor };
