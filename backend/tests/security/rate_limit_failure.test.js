/**
 * Phase 3.2E (F6) — invitation preview/accept limiters fail CLOSED; every other limiter keeps
 * its fail-open behaviour. Exercised through the REAL app and controller wiring.
 *
 * Redis isolation: the healthy path uses the shared test client (DB 15) and only the
 * ratelimit:invite-* / org namespaces of this suite's own users (deleted per test). Outages
 * are simulated by mocking methods of that client (restored after every test), plus one
 * isolated limiter pointed at an unused local port. No flush, no server change.
 */

const crypto = require('crypto');
const net = require('net');
const express = require('express');
const supertest = require('supertest');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const logger = require('../../src/observability/logger');
const invitationService = require('../../src/invitations/invitation.service');
const { getRedisClient, UNAVAILABLE_MESSAGE } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');
const { sha256, api, clearOrgRateLimits, newToken, createUser } = require('./invitation.helpers');

const UNAVAILABLE = { status: 'error', message: UNAVAILABLE_MESSAGE }; // AppError: 5xx → 'error'
const INVALID = { status: 'fail', message: 'Invitation not found or no longer valid.' };
const REDIS_SECRET_URL = 'redis://f6user:f6-redis-pass-synthetic@redis.internal.example:6379/0';
const COOKIE = 'f6-cookie-synthetic-value';

let org;
let invitee;
let redis;

const ENDPOINTS = {
  preview: { url: '/api/invitations/preview', max: 60, prefix: 'invite-preview' },
  accept: { url: '/api/invitations/accept', max: 20, prefix: 'invite-accept' },
};
const call = (name, token = newToken(), userToken = invitee.token) => supertest(app)
  .post(ENDPOINTS[name].url)
  .set('Authorization', `Bearer ${userToken}`)
  .set('Cookie', `refresh_token=${COOKIE}`)
  .set('X-Request-Id', `f6-${name}-req`)
  .send({ token });

// ── Outage simulations on the shared client (all restored in afterEach) ──
const redisError = () => Object.assign(new Error(`Connection lost to ${REDIS_SECRET_URL}`), { code: 'ECONNRESET' });
const chain = (exec) => { const c = { set: () => c, incr: () => c, exec }; return c; };
const OUTAGES = {
  'connection failure': () => {
    jest.spyOn(redis, 'isOpen', 'get').mockReturnValue(false);
    jest.spyOn(redis, 'connect').mockRejectedValue(Object.assign(new Error(`connect ECONNREFUSED ${REDIS_SECRET_URL}`), { code: 'ECONNREFUSED' }));
  },
  'disconnected, reconnecting (connect never settles)': () => {
    jest.spyOn(redis, 'isOpen', 'get').mockReturnValue(false);
    jest.spyOn(redis, 'connect').mockReturnValue(new Promise(() => {}));
  },
  'command failure': () => jest.spyOn(redis, 'multi').mockImplementation(() => chain(() => Promise.reject(redisError()))),
  'command throws synchronously': () => jest.spyOn(redis, 'multi').mockImplementation(() => { throw redisError(); }),
  'timeout (1s bound)': () => jest.spyOn(redis, 'multi').mockImplementation(() => chain(() => new Promise(() => {}))),
};

/** Capture structured log lines and console calls for the duration of fn. */
async function capture(fn) {
  const lines = [];
  const previous = logger.getLevel();
  logger.configure({ level: 'debug', write: (l) => lines.push(l) });
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
  try {
    await fn();
  } finally {
    logger.configure({ level: previous });
  }
  const consoleCalls = spies.flatMap(s => s.mock.calls);
  spies.forEach(s => s.mockRestore());
  return { lines, entries: lines.map(l => JSON.parse(l)), consoleCalls };
}
const limiterEntries = (entries) => entries.filter(e => e.operation === 'rate_limit');

async function ownKeys(user = invitee) {
  return [`ratelimit:invite-preview:${user.id}`, `ratelimit:invite-accept:${user.id}`];
}

beforeAll(async () => {
  const { rows: [db] } = await pool.query('SELECT current_database() AS name');
  expect(db.name).toBe('documind_test');
  expect(process.env.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+\/15$/); // test Redis DB 15 only
  redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
});

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  org = await h.createOrgWithUsers('f6-org', ['admin']);
  invitee = await createUser('f6-invitee@documind.test');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await redis.del(await ownKeys());
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await redis.quit();
  await pool.end();
});

describe.each(Object.keys(ENDPOINTS))('POST %s — fail-closed', (name) => {
  const { max, prefix } = ENDPOINTS[name];

  test('healthy Redis: requests below the limit proceed (generic 404 for an unknown token)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await call(name);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(INVALID);
    }
    expect(Number(await redis.get(`ratelimit:${prefix}:${invitee.id}`))).toBe(3);
    expect(await redis.ttl(`ratelimit:${prefix}:${invitee.id}`)).toBeGreaterThan(14 * 60); // 15-min window unchanged
  });

  test(`healthy Redis: request ${max + 1} gets the existing 429`, async () => {
    await redis.set(`ratelimit:${prefix}:${invitee.id}`, String(max - 1), { EX: 900 });
    expect((await call(name)).status).toBe(404); // the max-th request is still allowed
    const limited = await call(name);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ status: 'fail', message: 'Too many requests, please try again later.' });
  });

  test.each(Object.keys(OUTAGES))('%s → safe 503, the request never reaches the service', async (outage) => {
    const serviceFn = name === 'preview' ? 'previewInvitation' : 'acceptInvitation';
    const service = jest.spyOn(invitationService, serviceFn);
    OUTAGES[outage]();
    const token = newToken();
    const started = Date.now();
    const { entries, lines, consoleCalls } = await capture(async () => {
      const res = await call(name, token);
      expect(res.status).toBe(503);
      expect(res.body).toEqual(UNAVAILABLE);
      expect(res.headers['x-request-id']).toBe(`f6-${name}-req`);
      expect(res.headers['cache-control']).toBeUndefined(); // stopped before the route handler
      for (const leak of ['redis', 'ECONN', '6379', 'internal.example', 'f6-redis-pass', token]) expect(res.text).not.toContain(leak);
    });
    expect(Date.now() - started).toBeLessThan(5000); // bounded: never hangs
    expect(service).not.toHaveBeenCalled();
    const [entry, ...more] = limiterEntries(entries);
    expect(more).toEqual([]);
    expect(entry).toMatchObject({
      level: 'error', message: 'Rate limiter error; request rejected (fail-closed)', failClosed: true,
      requestId: `f6-${name}-req`, method: 'POST', route: ENDPOINTS[name].url,
    });
    const all = lines.join('\n');
    for (const secret of [token, sha256(token), invitee.token, COOKIE, 'f6-redis-pass-synthetic']) expect(all.includes(secret)).toBe(false);
    expect(consoleCalls).toEqual([]);
  });

  test('no bypass during an outage: every request is rejected, nothing is counted', async () => {
    OUTAGES['command failure']();
    const service = jest.spyOn(invitationService, name === 'preview' ? 'previewInvitation' : 'acceptInvitation');
    for (let i = 0; i < 5; i += 1) expect((await call(name)).status).toBe(503);
    expect(service).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(await redis.get(`ratelimit:${prefix}:${invitee.id}`)).toBeNull(); // no fallback counter anywhere
  });

  test('recovery: once Redis answers again, limiting resumes normally (counter and 429)', async () => {
    OUTAGES['command failure']();
    expect((await call(name)).status).toBe(503);
    jest.restoreAllMocks();
    expect((await call(name)).status).toBe(404);
    expect(Number(await redis.get(`ratelimit:${prefix}:${invitee.id}`))).toBe(1);
    await redis.set(`ratelimit:${prefix}:${invitee.id}`, String(max), { EX: 900 });
    expect((await call(name)).status).toBe(429);
  });
});

describe('every other limiter keeps fail-open (real controller wiring)', () => {
  // Each request passes ONLY if its limiter lets it through; the expected status comes from the
  // route itself (validation / business logic), never 503.
  const CASES = [
    ['auth login', () => supertest(app).post('/api/auth/login').send({}), 400],
    ['auth register', () => supertest(app).post('/api/auth/register').send({}), 400],
    ['organization (router-level)', () => api(org.users.admin.token).get(`/api/organizations/${org.orgId}/members`), 200],
    ['organization write', () => api(org.users.admin.token).post('/api/organizations').send({}), 400],
    ['invitation send', () => api(org.users.admin.token).post(`/api/organizations/${org.orgId}/invitations`).send({}), 400],
    ['RAG', () => api(org.users.admin.token).post('/api/rag/query').set('X-Organization-Id', org.orgId).send({}), 400],
    ['chat', () => api(org.users.admin.token).post(`/api/conversations/${crypto.randomUUID()}/messages`)
      .set('X-Organization-Id', org.orgId).send({}), [400, 404]],
  ];

  test.each(CASES)('%s: Redis command failure → request allowed, limiter logged as fail-open', async (_label, send, expected) => {
    OUTAGES['command failure']();
    const { entries, consoleCalls } = await capture(async () => {
      const res = await send();
      expect(res.status).not.toBe(503);
      expect([].concat(expected)).toContain(res.status);
    });
    const limiter = limiterEntries(entries);
    expect(limiter.length).toBeGreaterThanOrEqual(1); // the limiter really ran and failed
    expect(limiter.every(e => e.failClosed === false && e.message === 'Rate limiter error; request allowed (fail-open)')).toBe(true);
    expect(consoleCalls).toEqual([]);
  });

  test.each([CASES[0], CASES[3], CASES[5]])('%s: connection failure → still fail-open', async (_label, send, expected) => {
    OUTAGES['connection failure']();
    const res = await send();
    expect([].concat(expected)).toContain(res.status);
  });

  test('auth: a 1s Redis timeout is still fail-open', async () => {
    OUTAGES['timeout (1s bound)']();
    expect((await supertest(app).post('/api/auth/login').send({})).status).toBe(400);
  });
});

describe('a genuinely unreachable Redis (isolated client on an unused local port)', () => {
  async function unusedPort() {
    const srv = net.createServer();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise(r => srv.close(r));
    return port;
  }

  test('failClosed limiter → 503; default limiter → allowed', async () => {
    const port = await unusedPort();
    const previousUrl = process.env.REDIS_URL;
    let isolated;
    let isolatedLogger;
    process.env.REDIS_URL = `redis://127.0.0.1:${port}/15`;
    try {
      jest.isolateModules(() => {
        isolatedLogger = require('../../src/observability/logger');
        isolatedLogger.configure({ level: 'silent' });
        isolated = require('../../src/middleware/rate-limiter');
      });
    } finally {
      process.env.REDIS_URL = previousUrl;
    }
    const mini = express();
    mini.get('/closed', isolated({ max: 5, keyGenerator: () => 'ratelimit:f6-isolated:closed', failClosed: true }), (req, res) => res.json({ ok: true }));
    mini.get('/open', isolated({ max: 5, keyGenerator: () => 'ratelimit:f6-isolated:open' }), (req, res) => res.json({ ok: true }));
    try {
      const closed = await supertest(mini).get('/closed');
      expect(closed.status).toBe(503);
      expect(closed.text).toContain(UNAVAILABLE_MESSAGE);
      expect(closed.text).not.toContain(String(port));
      expect((await supertest(mini).get('/open')).status).toBe(200);
    } finally {
      const client = isolated.getRedisClient();
      await client.disconnect().catch(() => {});
    }
  });
});

describe('configuration', () => {
  test('failClosed defaults to false and must be exactly true', () => {
    const rateLimiter = require('../../src/middleware/rate-limiter');
    expect(rateLimiter().failClosed).toBe(false);
    expect(rateLimiter({ failClosed: 'true' }).failClosed).toBe(false);
    expect(rateLimiter({ failClosed: 1 }).failClosed).toBe(false);
    expect(rateLimiter({ failClosed: true }).failClosed).toBe(true);
  });

  test('only the invitation preview/accept limiters opt in (source audit of every limiter)', () => {
    const fs = require('fs');
    const path = require('path');
    const srcDir = path.join(__dirname, '..', '..', 'src');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name))));
    walk(srcDir);
    const optIns = [];
    let limiters = 0;
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(\w+)\s*=\s*rateLimiter\(\{([\s\S]*?)\n\}\);/g)) {
        limiters += 1;
        if (/failClosed\s*:\s*true/.test(m[2])) optIns.push(`${path.basename(f)}:${m[1]}`);
      }
    }
    expect(limiters).toBe(9); // 9th: googleRateLimiter (auth/google.controller.js), fail-open like the other auth limiters
    expect(optIns.sort()).toEqual(['invitation.controller.js:acceptRateLimiter', 'invitation.controller.js:previewRateLimiter']);
  });
});
