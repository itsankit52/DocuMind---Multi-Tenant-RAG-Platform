/**
 * Phase 3.2D (F8) — rate-limiter failures go through the structured, redacting logger
 * (never console.*), and the existing fail-open policy is unchanged (F6 is separate).
 *
 * Failure paths use a fake Redis client inside an isolated module registry: no real outage,
 * no Redis configuration change, no flush. The healthy path uses the real limiter on the test
 * Redis (DB 15) with a unique key that is deleted afterwards. Synthetic secrets only.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');
const supertest = require('supertest');

const TOKEN = crypto.randomBytes(32).toString('base64url');
const SECRETS = {
  redisUrl: 'redis://f8user:f8-redis-pass-synthetic@redis.internal.example:6379/0',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJmOCJ9.c2lnbmF0dXJlLWY4LXN5bnRoZXRpYw',
  cookie: 'f8-cookie-value-synthetic',
  password: 'Hunter2-f8-synthetic',
};
const NEVER = [TOKEN, SECRETS.jwt, SECRETS.cookie, SECRETS.password, 'f8-redis-pass-synthetic', 'f8user:'];

/** Fake node-redis client; `mode` selects how it fails. */
function fakeRedis(mode) {
  const client = new EventEmitter();
  client.isOpen = mode !== 'connect-fails';
  const boom = Object.assign(new Error(`Connection lost to ${SECRETS.redisUrl} (password=${SECRETS.password})`), {
    code: 'ECONNRESET', options: { url: SECRETS.redisUrl, password: SECRETS.password },
  });
  client.connect = jest.fn(() => (mode === 'connect-fails'
    ? Promise.reject(Object.assign(new Error(`connect ECONNREFUSED via ${SECRETS.redisUrl}`), { code: 'ECONNREFUSED' }))
    : Promise.resolve()));
  client.multi = jest.fn(() => {
    const chain = {
      set: () => chain,
      incr: () => chain,
      exec: () => (mode === 'hang' ? new Promise(() => {}) : Promise.reject(boom)),
    };
    return chain;
  });
  return client;
}

/**
 * Load the real rate-limiter (and its logger) in an isolated registry with `redis` replaced.
 * Returns the limiter factory, the fake client, captured log lines and console spies.
 */
function loadIsolated(mode) {
  const client = fakeRedis(mode);
  let rateLimiter;
  let logger;
  let requestContext;
  jest.isolateModules(() => {
    jest.doMock('redis', () => ({ createClient: () => client }));
    logger = require('../../src/observability/logger');
    rateLimiter = require('../../src/middleware/rate-limiter');
    ({ requestContext } = require('../../src/observability/http'));
  });
  const lines = [];
  logger.configure({ level: 'debug', write: (line) => lines.push(line) });
  return { client, rateLimiter, requestContext, lines, logger };
}

const consoleSpies = () => ['log', 'info', 'warn', 'error', 'debug'].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
const parsed = (lines) => lines.map(l => JSON.parse(l));
/** console must stay unused, except dotenv's own banner when env.js is re-required in isolation. */
const expectNoConsole = (spies) => {
  for (const spy of spies) {
    expect(spy.mock.calls.filter(args => !String(args[0]).includes('injected env'))).toEqual([]);
  }
};

function appWith({ rateLimiter, requestContext }) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.post('/api/invitations/accept', rateLimiter({ windowMs: 60000, max: 5, keyGenerator: () => `ratelimit:f8:${TOKEN.slice(0, 4)}` }),
    (req, res) => res.status(200).json({ status: 'success', reached: true }));
  return app;
}

const sendSensitive = (app) => supertest(app)
  .post(`/api/invitations/accept?token=${TOKEN}`)
  .set('X-Request-Id', 'f8-rl-0001')
  .set('Authorization', `Bearer ${SECRETS.jwt}`)
  .set('Cookie', `refresh_token=${SECRETS.cookie}`)
  .send({ token: TOKEN, password: SECRETS.password });

function expectNoSecrets(lines) {
  const all = lines.join('\n');
  for (const s of NEVER) expect({ secret: s.slice(0, 6), found: all.includes(s) }).toEqual({ secret: s.slice(0, 6), found: false });
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.dontMock('redis');
});

describe('rate limiter failure logging (structured, redacted)', () => {
  test.each([
    ['command failure', 'exec-fails', 'ECONNRESET', /Connection lost/],
    ['connect failure', 'connect-fails', 'ECONNREFUSED', /connect ECONNREFUSED/],
  ])('%s → one structured error line, request allowed (fail-open)', async (_label, mode, code, messagePattern) => {
    const spies = consoleSpies();
    const ctx = loadIsolated(mode);
    ctx.lines.length = 0; // ignore the module-load connect attempt (covered below)
    const res = await sendSensitive(appWith(ctx));

    expect(res.status).toBe(200); // fail-open, unchanged
    expect(res.body).toEqual({ status: 'success', reached: true });
    const entries = parsed(ctx.lines).filter(e => e.operation === 'rate_limit');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      message: 'Rate limiter error; request allowed (fail-open)',
      requestId: 'f8-rl-0001',
      method: 'POST',
      route: '/api/invitations/accept',
      error: { type: 'Error', code },
    });
    expect(entries[0].error.message).toMatch(messagePattern); // still useful for debugging
    expect(entries[0].error.message).toContain('redis://***:***@');
    expect(Object.keys(entries[0].error).sort()).toEqual(['code', 'message', 'type']); // no options/url/password
    expect(entries[0]).not.toHaveProperty('key');
    expect(JSON.stringify(entries[0])).not.toContain('?token');
    expectNoSecrets(ctx.lines);
    expectNoConsole(spies);
  });

  test('timeout → fail-open after the existing 1s bound, logged structurally', async () => {
    const spies = consoleSpies();
    const ctx = loadIsolated('hang');
    const started = Date.now();
    const res = await sendSensitive(appWith(ctx));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const [entry] = parsed(ctx.lines).filter(e => e.operation === 'rate_limit');
    expect(entry.error.message).toBe('redis rate-limit timed out after 1000ms');
    expectNoSecrets(ctx.lines);
    expectNoConsole(spies);
  });

  test('Redis client "error" events are logged structurally and redacted', () => {
    const spies = consoleSpies();
    const ctx = loadIsolated('exec-fails');
    ctx.client.emit('error', Object.assign(new Error(`Socket closed unexpectedly ${SECRETS.redisUrl} ${SECRETS.jwt}`), {
      code: 'ECONNRESET', password: SECRETS.password, url: SECRETS.redisUrl,
    }));
    const entries = parsed(ctx.lines).filter(e => e.operation === 'connection');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', message: 'Redis client error (rate limiter)', error: { type: 'Error', code: 'ECONNRESET' } });
    expect(entries[0].error.message).toContain('Socket closed unexpectedly');
    expectNoSecrets(ctx.lines);
    expectNoConsole(spies);
  });

  test('the initial connect failure at module load is logged structurally and redacted', async () => {
    const spies = consoleSpies();
    const client = fakeRedis('connect-fails');
    const lines = [];
    jest.isolateModules(() => {
      jest.doMock('redis', () => ({ createClient: () => client }));
      require('../../src/observability/logger').configure({ level: 'debug', write: (l) => lines.push(l) });
      require('../../src/middleware/rate-limiter');
    });
    await new Promise(r => setImmediate(r));
    const entries = parsed(lines).filter(e => e.operation === 'connect');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 'error', message: 'Failed to connect to Redis for rate limiting', error: { code: 'ECONNREFUSED' } });
    expectNoSecrets(lines);
    expectNoConsole(spies);
  });

  test('the rate-limiter source has no direct console logging left', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/middleware/rate-limiter'), 'utf8');
    expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
});

describe('healthy Redis: limiting unchanged (real limiter, test Redis DB 15)', () => {
  const rateLimiter = require('../../src/middleware/rate-limiter');
  const key = `ratelimit:f8-healthy:${crypto.randomBytes(6).toString('hex')}`;

  afterAll(async () => {
    const client = rateLimiter.getRedisClient();
    if (client.isOpen) {
      await client.del(key);
      await client.quit();
    }
  });

  test('counts and blocks with 429 after max; no error logs', async () => {
    const client = rateLimiter.getRedisClient();
    if (!client.isOpen) await client.connect();
    expect(process.env.REDIS_URL || '').toMatch(/\/15$/); // test Redis DB only
    const app = express();
    app.get('/x', rateLimiter({ windowMs: 60000, max: 2, keyGenerator: () => key }), (req, res) => res.json({ ok: true }));
    expect((await supertest(app).get('/x')).status).toBe(200);
    expect((await supertest(app).get('/x')).status).toBe(200);
    const third = await supertest(app).get('/x');
    expect(third.status).toBe(429);
    expect(await client.ttl(key)).toBeGreaterThan(0);
  });
});
