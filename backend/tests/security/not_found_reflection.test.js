/**
 * Phase 3.2B (F4) — the Express 404 catch-all must never reflect the query string.
 *
 * Before the fix, `Can't find ${req.originalUrl} …` echoed e.g. /api/invitations/previe?token=…
 * back to the caller. The message now uses req.path. Envelope and status are unchanged:
 *   404 { status: 'fail', message: "Can't find <path> on this server!" }
 * Synthetic tokens only; token values are never printed.
 */

const crypto = require('crypto');
const supertest = require('supertest');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const h = require('../streaming/stream.helpers');
const { createUser } = require('./invitation.helpers');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const syntheticToken = () => crypto.randomBytes(32).toString('base64url');
const notFound = (path) => ({ status: 'fail', message: `Can't find ${path} on this server!` });

/** Nothing derived from `secret` appears anywhere in the response (body or headers). */
function expectNotReflected(res, secret) {
  const everything = `${res.text}\n${JSON.stringify(res.headers)}`;
  for (const form of [secret, encodeURIComponent(secret), sha256(secret)]) {
    expect(everything.includes(form)).toBe(false);
  }
}

let user;

beforeAll(async () => {
  const { rows: [db] } = await pool.query('SELECT current_database() AS name');
  expect(db.name).toBe('documind_test');
  await h.truncateAll();
  user = await createUser('not-found-reflection@documind.test');
});

afterAll(async () => {
  await h.truncateAll();
  await pool.end();
});

describe('404 catch-all does not reflect query parameters (F4)', () => {
  test('unknown API route keeps the existing 404 envelope and message', async () => {
    const res = await supertest(app).get('/api/unknown-endpoint');
    expect(res.status).toBe(404);
    expect(res.body).toEqual(notFound('/api/unknown-endpoint'));
  });

  test('unknown route with ?token= returns the path only', async () => {
    const token = syntheticToken();
    const res = await supertest(app).get(`/api/unknown-endpoint?token=${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(notFound('/api/unknown-endpoint'));
    expectNotReflected(res, token);
  });

  test('arbitrary query parameters are not reflected', async () => {
    const token = syntheticToken();
    const res = await supertest(app).get(`/api/nothing/here?a=1&secret=s3cr3t-value&token=${token}&b=<script>`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(notFound('/api/nothing/here'));
    for (const fragment of ['?', 'a=1', 's3cr3t-value', '<script>', 'token=']) {
      expect(res.body.message).not.toContain(fragment);
    }
    expectNotReflected(res, token);
  });

  test('URL-encoded and double-encoded tokens are not reflected', async () => {
    const token = syntheticToken();
    for (const query of [
      `token=${encodeURIComponent(token)}`,
      `token=${encodeURIComponent(encodeURIComponent(token))}`,
      `t%6Fken=${token}`, // percent-encoded parameter name
    ]) {
      const res = await supertest(app).get(`/api/unknown-endpoint?${query}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(notFound('/api/unknown-endpoint'));
      expectNotReflected(res, token);
    }
  });

  test('misspelled invitation preview path (authenticated) is a path-only 404', async () => {
    const token = syntheticToken();
    const res = await supertest(app)
      .get(`/api/invitations/previe?token=${token}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(notFound('/api/invitations/previe'));
    expectNotReflected(res, token);
  });

  test('misspelled invitation preview path (unauthenticated) is rejected without reflection', async () => {
    const token = syntheticToken();
    const res = await supertest(app).get(`/api/invitations/previe?token=${token}`);
    expect(res.status).toBe(401);
    expectNotReflected(res, token);
  });

  test('other methods and non-API paths behave the same', async () => {
    const token = syntheticToken();
    const post = await supertest(app).post(`/api/invitations/accepted?token=${token}`)
      .set('Authorization', `Bearer ${user.token}`).send({ token });
    expect(post.status).toBe(404);
    expect(post.body).toEqual(notFound('/api/invitations/accepted'));
    expectNotReflected(post, token);

    const page = await supertest(app).get(`/invite-typo?token=${token}`);
    expect(page.status).toBe(404);
    expect(page.body).toEqual(notFound('/invite-typo'));
    expectNotReflected(page, token);
  });

  test('the path is still reported, so the message stays useful and compatible', async () => {
    const res = await supertest(app).get('/api/v2/missing/resource?x=1');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'status']);
    expect(res.body.message).toBe("Can't find /api/v2/missing/resource on this server!");
  });
});
