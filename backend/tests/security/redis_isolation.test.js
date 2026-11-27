/**
 * Phase 2.2 — backend tests run on a dedicated Redis logical database.
 *
 * - The shared application client (rate-limiter.js, the only Redis client) is connected to
 *   the non-zero database named by REDIS_URL, as reported by the server (CLIENT INFO).
 * - A key written by the suites is not visible in database 0 (read-only EXISTS check there).
 * - The globalSetup guard refuses missing, implicit (.env) and database-0 Redis URLs.
 * - No test or application file issues FLUSHALL / FLUSHDB.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const redis = require('redis');
const env = require('../../src/config/env');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const { assertTestRedis, redisTarget } = require('../guard-test-db');

const BACKEND_DIR = path.join(__dirname, '..', '..');
let client;

beforeAll(async () => {
  client = getRedisClient();
  if (!client.isOpen) await client.connect();
});

afterAll(async () => {
  if (client && client.isOpen) await client.quit();
});

describe('Redis test database', () => {
  test('REDIS_URL selects a dedicated non-zero database and the live connection uses it', async () => {
    const target = redisTarget(env.REDIS_URL);
    expect(target).not.toBeNull();
    expect(target.db).toBeGreaterThan(0);

    const info = await client.sendCommand(['CLIENT', 'INFO']);
    const db = Number(/(?:^|\s)db=(\d+)/.exec(info)[1]);
    expect(db).toBe(target.db);
  });

  test('keys written by the suites are not visible in database 0 (read-only check)', async () => {
    const probe = `ratelimit:isolation-probe:${crypto.randomBytes(8).toString('hex')}`;
    const u = new URL(env.REDIS_URL);
    u.pathname = '/0';
    const db0 = redis.createClient({ url: u.toString() });
    await db0.connect();
    try {
      await client.set(probe, '1', { EX: 30 });
      expect(await client.exists(probe)).toBe(1);
      expect(await db0.exists(probe)).toBe(0); // EXISTS only: database 0 is never written
    } finally {
      await client.del(probe);
      await db0.quit();
    }
  });
});

describe('globalSetup Redis guard', () => {
  const dev = { host: '127.0.0.1', port: '6380', db: 0 };

  test('accepts an explicit dedicated database', () => {
    expect(assertTestRedis('redis://127.0.0.1:6380/15', dev)).toEqual({ host: '127.0.0.1', port: '6380', db: 15 });
  });

  test.each([
    ['missing (would fall back to .env)', undefined, /without an explicit REDIS_URL/],
    ['empty', '', /without an explicit REDIS_URL/],
    ['implicit database 0', 'redis://127.0.0.1:6380', /database 0/],
    ['explicit database 0', 'redis://127.0.0.1:6380/0', /database 0/],
    ['non-numeric database', 'redis://127.0.0.1:6380/abc', /not a valid redis/],
    ['wrong scheme', 'http://127.0.0.1:6380/15', /not a valid redis/],
  ])('refuses %s', (_label, url, message) => {
    expect(() => assertTestRedis(url, dev)).toThrow(message);
  });

  test('refuses the database configured for development in .env', () => {
    expect(() => assertTestRedis('redis://127.0.0.1:6380/3', { ...dev, db: 3 })).toThrow(/development Redis database 3/);
  });

  test('globalSetup itself refuses a run without an explicit REDIS_URL (child process)', () => {
    const { spawnSync } = require('child_process');
    const childEnv = { ...process.env };
    delete childEnv.REDIS_URL;
    const script = "require('./tests/guard-test-db.js')().then(() => process.stdout.write('ALLOWED'), e => process.stdout.write('REFUSED: ' + e.message))";
    const refused = spawnSync(process.execPath, ['-e', script], { cwd: BACKEND_DIR, env: childEnv, encoding: 'utf8', timeout: 20000 });
    expect(refused.stdout).toMatch(/^REFUSED: .*explicit REDIS_URL/);

    const allowed = spawnSync(process.execPath, ['-e', script], {
      cwd: BACKEND_DIR, env: { ...childEnv, REDIS_URL: 'redis://127.0.0.1:6380/15' }, encoding: 'utf8', timeout: 20000,
    });
    expect(allowed.stdout).toBe('ALLOWED');
  });
});

describe('no Redis flush commands', () => {
  function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : jsFiles(p);
      return e.name.endsWith('.js') ? [p] : [];
    });
  }

  test('no source or test file calls FLUSHALL or FLUSHDB', () => {
    const offenders = [...jsFiles(path.join(BACKEND_DIR, 'src')), ...jsFiles(path.join(BACKEND_DIR, 'tests'))]
      .filter(f => f !== __filename)
      .filter(f => /\.flush(All|Db)\s*\(|['"`]FLUSH(ALL|DB)['"`]/i.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
