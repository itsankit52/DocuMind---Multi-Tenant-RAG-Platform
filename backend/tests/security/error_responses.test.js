/**
 * Phase 3.2D (F8) — error responses never leak internals.
 *
 * The handler (src/middleware/error-handler.js) is mounted on small Express apps in both
 * modes, so every error shape can be produced deterministically; the real app is checked for
 * its wiring (NODE_ENV=test in-process, NODE_ENV=development in a child process).
 * No database or Redis operation is performed by these tests. Synthetic secrets only.
 */

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const supertest = require('supertest');
const env = require('../../src/config/env');
const AppError = require('../../src/utils/AppError');
const { requestContext } = require('../../src/observability/http');
const { createErrorHandler, developmentDiagnosticsEnabled } = require('../../src/middleware/error-handler');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const TOKEN = crypto.randomBytes(32).toString('base64url');
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const SECRETS = {
  password: 'Hunter2-f8-synthetic',
  dbUrl: 'postgres://f8_user:f8-db-pass-synthetic@db.internal.example:5432/documind',
  redisUrl: 'redis://:f8-redis-pass-synthetic@redis.internal.example:6379/0',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJmOCJ9.c2lnbmF0dXJlLWY4LXN5bnRoZXRpYw',
};
// Fragments that must never reach a production response.
const INTERNALS = [
  'SELECT', 'password_hash', 'users_email_key', 'parse_relation.c', 'Key (email)', 'alice@example.com',
  'db.internal.example', 'redis.internal.example', 'ECONNREFUSED', '10.0.0.5', '/app/', 'node_modules',
  '.js:', 'at ', 'stack', 'cause', TOKEN, TOKEN_HASH, ...Object.values(SECRETS), 'f8-db-pass', 'f8-redis-pass',
];
// Secret material that must never reach ANY response, development included.
const NEVER = [
  TOKEN, TOKEN_HASH, SECRETS.password, SECRETS.jwt, 'f8-db-pass-synthetic', 'f8-redis-pass-synthetic',
  'alice@example.com', 'Key (email)', env.DATABASE_URL, env.REDIS_URL, env.JWT_ACCESS_SECRET,
  env.JWT_REFRESH_SECRET, env.COOKIE_SECRET,
];

function pgError() {
  return Object.assign(new Error(`relation "secret_table" does not exist (connecting to ${SECRETS.dbUrl})`), {
    name: 'DatabaseError', code: '42P01', severity: 'ERROR', detail: 'Key (email)=(alice@example.com) already exists.',
    query: `SELECT id, password_hash FROM users WHERE email = 'alice@example.com' AND token = '${TOKEN}'`,
    schema: 'public', table: 'users', constraint: 'users_email_key', file: 'parse_relation.c', line: '1384',
  });
}
function redisError() {
  return Object.assign(new Error(`connect ECONNREFUSED 10.0.0.5:6379 (${SECRETS.redisUrl})`), {
    name: 'Error', code: 'ECONNREFUSED', address: '10.0.0.5', port: 6379, url: SECRETS.redisUrl,
  });
}
function credentialError() {
  return Object.assign(
    new Error(`login failed: password=${SECRETS.password} token=${TOKEN} hash ${TOKEN_HASH} Bearer ${SECRETS.jwt}`),
    { password: SECRETS.password, config: { headers: { authorization: `Bearer ${SECRETS.jwt}` } }, env: { ...process.env } },
  );
}

/** A tiny app with one route per error shape, then the handler under test. */
function buildApp(developmentDiagnostics) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(cookieParser());
  const routes = {
    pg: (req, res, next) => next(AppError.from(pgError())),
    'pg-raw': (req, res, next) => next(pgError()),
    redis: (req, res, next) => next(AppError.from(redisError())),
    validation: (req, res, next) => next(new AppError('Invitation token is malformed', 400)),
    'with-code': (req, res, next) => next(new AppError('You are already a member.', 409, 'ALREADY_ORGANIZATION_MEMBER')),
    unexpected: () => { throw new TypeError("Cannot read properties of undefined (reading 'id') at /app/src/x.js:12"); },
    async: async () => { throw new RangeError('async boom /app/src/y.js'); },
    nested: (req, res, next) => {
      const inner = Object.assign(new Error(`inner ${SECRETS.dbUrl}`), { cause: credentialError() });
      next(AppError.from(Object.assign(new Error('middle'), { cause: inner })));
    },
    sql: (req, res, next) => next(Object.assign(new Error(pgError().query), { statusCode: 500 })),
    fs: (req, res, next) => next(Object.assign(
      new Error("ENOENT: no such file or directory, open '/app/uploads/org-a/secret.pdf'"),
      { code: 'ENOENT', errno: -2, syscall: 'open', path: '/app/uploads/org-a/secret.pdf' },
    )),
    credentials: (req, res, next) => next(credentialError()),
    'credentials-op': (req, res, next) => next(Object.assign(new AppError('Request failed', 500), { cause: credentialError() })),
  };
  for (const [name, handler] of Object.entries(routes)) app.all(`/boom/${name}`, handler);
  app.use(createErrorHandler({ developmentDiagnostics }));
  return app;
}

const prodApp = buildApp(false);
const devApp = buildApp(true);
const ROUTES = ['pg', 'pg-raw', 'redis', 'unexpected', 'async', 'nested', 'sql', 'fs', 'credentials', 'credentials-op'];

const textOf = (res) => `${res.text}\n${JSON.stringify(res.headers)}`;
const expectNone = (res, fragments) => {
  const all = textOf(res);
  for (const f of fragments) expect({ fragment: f, found: all.includes(f) }).toEqual({ fragment: f, found: false });
};

describe('production / non-development responses', () => {
  test.each(ROUTES)('%s → 500 { status, message } only, nothing internal', async (route) => {
    const res = await supertest(prodApp).get(`/boom/${route}`);
    expect(res.status).toBe(500);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'status']);
    expect(res.body.status).toBe('error');
    expect(['Internal server error', 'Something went wrong!', 'Request failed']).toContain(res.body.message);
    expectNone(res, INTERNALS);
  });

  test('PostgreSQL error: generic message, no SQLSTATE detail, query, table or constraint', async () => {
    const res = await supertest(prodApp).get('/boom/pg');
    expect(res.body).toEqual({ status: 'error', message: 'Internal server error' });
  });

  test('unexpected (non-operational) exception: the fixed generic message', async () => {
    for (const route of ['unexpected', 'async', 'pg-raw', 'fs', 'credentials']) {
      expect((await supertest(prodApp).get(`/boom/${route}`)).body).toEqual({ status: 'error', message: 'Something went wrong!' });
    }
  });

  test('validation errors keep their public message and 400 status', async () => {
    const res = await supertest(prodApp).get('/boom/validation');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'fail', message: 'Invitation token is malformed' });
  });

  test('safe AppError codes are preserved', async () => {
    const res = await supertest(prodApp).get('/boom/with-code');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ status: 'fail', message: 'You are already a member.', code: 'ALREADY_ORGANIZATION_MEMBER' });
  });

  test('the request ID is preserved on error responses', async () => {
    const res = await supertest(prodApp).get('/boom/pg').set('X-Request-Id', 'f8-req-0001');
    expect(res.headers['x-request-id']).toBe('f8-req-0001');
    const generated = await supertest(prodApp).get('/boom/unexpected');
    expect(generated.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]{8,}$/);
  });

  test('a malformed JSON body (raw body text) is never echoed', async () => {
    const res = await supertest(prodApp).post('/boom/validation').set('Content-Type', 'application/json')
      .send(`{"password":"${SECRETS.password}","token":"${TOKEN}"`);
    expect(res.status).toBe(400);
    expectNone(res, [SECRETS.password, TOKEN, 'stack', 'body']);
  });
});

describe('explicit development diagnostics', () => {
  test.each(ROUTES)('%s → safe summary + redacted stack, no cause, no secrets', async (route) => {
    const res = await supertest(devApp).get(`/boom/${route}`);
    expect(res.status).toBe(500);
    expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'stack', 'status']);
    expect(typeof res.body.stack).toBe('string');
    expect(res.body.stack).toMatch(/\n\s+at /); // still useful for local debugging
    expect(Object.keys(res.body.error).every(k => ['type', 'statusCode', 'isOperational', 'causeType', 'causeCode'].includes(k))).toBe(true);
    expect(Object.values(res.body.error).every(v => ['string', 'number', 'boolean'].includes(typeof v))).toBe(true);
    expect(res.body.error).not.toHaveProperty('cause');
    expectNone(res, NEVER);
  });

  test('wrapped PostgreSQL error: type and SQLSTATE of the cause only (no detail/query/table)', async () => {
    const res = await supertest(devApp).get('/boom/pg');
    expect(res.body.message).toBe('Internal server error');
    expect(res.body.error).toEqual({ type: 'Error', statusCode: 500, isOperational: true, causeType: 'DatabaseError', causeCode: '42P01' });
    expectNone(res, ['secret_table', 'users_email_key', 'parse_relation.c', 'SELECT', 'db.internal.example']);
  });

  test('unwrapped errors keep their (redacted) message for debugging', async () => {
    const fs = await supertest(devApp).get('/boom/fs');
    expect(fs.body.message).toContain('ENOENT'); // paths are acceptable locally
    expect(fs.body.error).toMatchObject({ type: 'Error', isOperational: false });

    const creds = await supertest(devApp).get('/boom/credentials');
    expect(creds.body.message).toContain('login failed');
    expect(creds.body.message).toContain('password=[REDACTED]');
    expect(creds.body.message).toContain('[REDACTED');
  });

  test('database and Redis URLs with credentials are not exposed', async () => {
    const pg = await supertest(devApp).get('/boom/pg-raw');
    expect(pg.body.message).toContain('postgres://***:***@');
    const redisRes = await supertest(devApp).get('/boom/redis');
    const nested = await supertest(devApp).get('/boom/nested');
    for (const res of [pg, redisRes, nested]) expectNone(res, ['f8-db-pass-synthetic', 'f8-redis-pass-synthetic', 'f8_user:']);
  });

  test('configured secret values are scrubbed verbatim from messages and stacks', async () => {
    const app = express();
    app.get('/leak', () => { throw new Error(`cfg ${env.DATABASE_URL} ${env.REDIS_URL} ${env.JWT_ACCESS_SECRET} ${env.COOKIE_SECRET}`); });
    app.use(createErrorHandler({ developmentDiagnostics: true }));
    const res = await supertest(app).get('/leak');
    expect(res.body.message).toMatch(/^cfg /);
    expectNone(res, [env.DATABASE_URL, env.REDIS_URL, env.JWT_ACCESS_SECRET, env.COOKIE_SECRET]);
  });

  test('a malformed JSON body (raw request body) is never serialized', async () => {
    const res = await supertest(devApp).post('/boom/validation').set('Content-Type', 'application/json')
      .send(`{"password":"${SECRETS.password}","token":"${TOKEN}"`);
    expect(res.status).toBe(400);
    expect(res.body.stack).toEqual(expect.any(String));
    expectNone(res, [SECRETS.password, TOKEN, '"body"', '"rawBody"']);
  });

  test('request headers and cookies are never reflected', async () => {
    const res = await supertest(devApp).get('/boom/credentials')
      .set('Authorization', `Bearer ${SECRETS.jwt}`).set('Cookie', `refresh_token=${TOKEN}; sid=${SECRETS.password}`);
    expectNone(res, [SECRETS.jwt, TOKEN, SECRETS.password]);
  });
});

describe('mode isolation', () => {
  test.each([
    ['development', true], [undefined, false], ['', false], ['production', false], ['test', false],
    ['Development', false], [' development', false], ['development ', false], ['dev', false],
  ])('NODE_ENV=%p → diagnostics %p (exact, explicit value only)', (value, expected) => {
    expect(developmentDiagnosticsEnabled(value)).toBe(expected);
  });

  test('headers, query, body and cookies cannot force development output', async () => {
    const forcing = [
      (r) => r.set('X-Debug', '1').set('X-Env', 'development').set('NODE_ENV', 'development').set('X-Node-Env', 'development'),
      (r) => r.query({ NODE_ENV: 'development', debug: 'true', env: 'development', stack: '1' }),
      (r) => r.set('Cookie', 'NODE_ENV=development; debug=1; env=development'),
      (r) => r.send({ NODE_ENV: 'development', debug: true, env: 'development' }),
    ];
    for (const force of forcing) {
      for (const method of ['get', 'post']) {
        const res = await force(supertest(prodApp)[method]('/boom/pg'));
        expect(res.body).toEqual({ status: 'error', message: 'Internal server error' });
      }
    }
  });

  test('the real app under NODE_ENV=test exposes no diagnostics', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const app = require('../../src/app');
    const res = await supertest(app).post('/api/auth/login').set('Content-Type', 'application/json')
      .send(`{"email":"a@b.c","password":"${SECRETS.password}"`);
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).not.toHaveProperty('error');
    expectNone(res, [SECRETS.password]);
    await require('../../src/middleware/rate-limiter').getRedisClient().quit().catch(() => {});
    await require('../../src/db').pool.end();
  });

  test('the real app wires diagnostics from an explicit NODE_ENV=development (child process)', () => {
    const script = `
      const supertest = require('supertest');
      const app = require('./src/app');
      supertest(app).post('/api/auth/login').set('Content-Type', 'application/json')
        .send('{"password":"' + process.env.F8_SECRET + '"')
        .then((res) => {
          process.stdout.write('F8_RESULT ' + JSON.stringify({ status: res.status, keys: Object.keys(res.body).sort(),
            leaked: res.text.includes(process.env.F8_SECRET) }) + '\\n');
          process.exit(0);
        }, () => process.exit(2));
    `;
    const out = spawnSync(process.execPath, ['-e', script], {
      cwd: BACKEND_DIR,
      env: { ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'silent', F8_SECRET: SECRETS.password },
      encoding: 'utf8',
      timeout: 30000,
    });
    const line = (out.stdout || '').split('\n').find(l => l.startsWith('F8_RESULT '));
    expect(line).toBeDefined();
    expect(JSON.parse(line.slice('F8_RESULT '.length))).toEqual({
      status: 400, keys: ['error', 'message', 'stack', 'status'], leaked: false,
    });
  });
});
