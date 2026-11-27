/**
 * Phase 3.3 WP4 (F5) — case-insensitive email uniqueness (migration 011).
 *
 * The database enforces UNIQUE (lower(btrim(email))) on users, so no client — the API, a
 * legacy script or manual SQL — can store a case or space variant of an existing address.
 * Real PostgreSQL (documind_test) and Redis DB 15 (only auth rate-limit keys are cleared).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const supertest = require('supertest');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const userRepo = require('../../src/repositories/user.repository');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');

const MIGRATION = '011_users_email_case_insensitive_unique.sql';
const PASSWORD = 'Password123!';
const register = (email) => supertest(app).post('/api/auth/register').send({ email, password: PASSWORD, fullName: 'F5 User' });
const login = (email) => supertest(app).post('/api/auth/login').send({ email, password: PASSWORD });
const usersLike = async (normalized) =>
  (await pool.query('SELECT id, email FROM users WHERE lower(btrim(email)) = $1', [normalized])).rows;
const insertUser = (db, email) => db.query("INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id", [email]);

async function clearAuthLimits() {
  const redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
  const keys = [];
  for await (const k of redis.scanIterator({ MATCH: 'ratelimit:auth:*', COUNT: 100 })) keys.push(...[].concat(k));
  if (keys.length) await redis.del(keys);
}

const open = [];
async function connect() {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  open.push(c);
  const { rows: [s] } = await c.query('SELECT current_database() AS db, pg_backend_pid() AS pid');
  if (s.db !== 'documind_test') throw new Error('refusing: not documind_test');
  c.pid = s.pid;
  return c;
}

beforeEach(async () => {
  await h.truncateAll();
  await clearAuthLimits();
});
afterEach(async () => {
  while (open.length) {
    const c = open.pop();
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
  }
});
afterAll(async () => {
  await h.truncateAll();
  await clearAuthLimits();
  await pool.end();
});

describe('migration 011', () => {
  test('applied once, with the checksum of the file on disk', async () => {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../migrations', MIGRATION), 'utf8')).digest('hex');
    const { rows } = await pool.query('SELECT checksum FROM schema_migrations WHERE filename = $1', [MIGRATION]);
    expect(rows).toEqual([{ checksum: sum }]);
  });

  test('a unique, valid expression index on lower(btrim(email)); the original key is kept', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname, i.indisunique, i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'users'::regclass AND c.relname IN ('uidx_users_email_normalized', 'users_email_key')
       ORDER BY c.relname`);
    expect(rows.map(r => [r.relname, r.indisunique, r.indisvalid])).toEqual([
      ['uidx_users_email_normalized', true, true], ['users_email_key', true, true],
    ]);
    expect(rows[0].def).toContain('(lower(btrim((email)::text)))');
  });
});

describe('database enforcement (any client)', () => {
  test.each([
    ['upper case', 'F5.Case@Example.TEST'],
    ['mixed case', 'f5.case@EXAMPLE.test'],
    ['leading/trailing spaces', '  f5.case@example.test '],
  ])('a %s variant of an existing address is rejected (23505 on the new index)', async (_l, variant) => {
    await insertUser(pool, 'f5.case@example.test');
    await expect(insertUser(pool, variant)).rejects.toMatchObject({ code: '23505', constraint: 'uidx_users_email_normalized' });
    expect(await usersLike('f5.case@example.test')).toHaveLength(1);
  });

  test('changing an address into a variant of another is rejected too (UPDATE)', async () => {
    await insertUser(pool, 'f5.one@example.test');
    const { rows: [two] } = await insertUser(pool, 'f5.two@example.test');
    await expect(pool.query("UPDATE users SET email = 'F5.ONE@example.test' WHERE id = $1", [two.id]))
      .rejects.toMatchObject({ code: '23505', constraint: 'uidx_users_email_normalized' });
  });

  test('distinct addresses (incl. plus tags and similar local parts) are still allowed', async () => {
    for (const e of ['f5@example.test', 'f5+a@example.test', 'f5.a@example.test', 'f5@example.org']) await insertUser(pool, e);
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(4);
  });

  test('concurrent inserts of two variants: the second waits on the first, then fails; nothing duplicated', async () => {
    const a = await connect();
    const b = await connect();
    await a.query('BEGIN');
    await insertUser(a, 'Race@Example.test');
    await b.query('BEGIN');
    const second = insertUser(b, 'race@example.TEST').then(() => 'inserted', e => `${e.code}:${e.constraint}`);
    // deterministic: observe b blocked by a on the uniqueness check
    for (;;) {
      const { rows } = await pool.query('SELECT pg_blocking_pids($1) AS p', [b.pid]);
      if (rows[0].p.includes(a.pid)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    await a.query('COMMIT');
    expect(await second).toBe('23505:uidx_users_email_normalized');
    await b.query('ROLLBACK');
    expect(await usersLike('race@example.test')).toHaveLength(1);
  });

  test('if the first concurrent insert rolls back, the waiting one succeeds', async () => {
    const a = await connect();
    const b = await connect();
    await a.query('BEGIN');
    await insertUser(a, 'Race2@Example.test');
    await b.query('BEGIN');
    const second = insertUser(b, 'race2@example.test').then(() => 'inserted', e => e.code);
    for (;;) {
      const { rows } = await pool.query('SELECT pg_blocking_pids($1) AS p', [b.pid]);
      if (rows[0].p.includes(a.pid)) break;
      await new Promise(r => setTimeout(r, 10));
    }
    await a.query('ROLLBACK');
    expect(await second).toBe('inserted');
    await b.query('COMMIT');
    expect(await usersLike('race2@example.test')).toEqual([expect.objectContaining({ email: 'race2@example.test' })]);
  });
});

describe('API behaviour', () => {
  test('registration stores the trimmed, lower-cased address', async () => {
    const res = await register('  New.User@Example.TEST ');
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('new.user@example.test');
    expect(await usersLike('new.user@example.test')).toHaveLength(1);
  });

  test.each(['NEW.USER@example.test', 'new.user@EXAMPLE.TEST', '   new.user@example.test'])(
    'a case/space variant %p cannot register again (existing 400)', async (variant) => {
      expect((await register('new.user@example.test')).status).toBe(201);
      const res = await register(variant);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: 'fail', message: 'Email already registered' });
      expect(await usersLike('new.user@example.test')).toHaveLength(1);
    });

  test('concurrent registrations of two variants: exactly one account', async () => {
    const results = await Promise.all([register('Conc@Example.test'), register('conc@EXAMPLE.test'), register(' CONC@example.test')]);
    const statuses = results.map(r => r.status).sort();
    expect(statuses.filter(s => s === 201)).toHaveLength(1);
    for (const r of results.filter(x => x.status !== 201)) {
      expect([400, 409]).toContain(r.status); // app pre-check (400) or the database constraint (409)
      expect(r.text).not.toMatch(/uidx_|users_email_key|23505|duplicate key/);
    }
    expect(await usersLike('conc@example.test')).toHaveLength(1);
  });

  test('login works with any case/space variation of the registered address', async () => {
    expect((await register('login.user@example.test')).status).toBe(201);
    for (const variant of ['LOGIN.USER@EXAMPLE.TEST', ' Login.User@example.test ']) {
      const res = await login(variant);
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('login.user@example.test');
    }
  });

  test('user lookup by email is unambiguous: every variant resolves to the same single row', async () => {
    const { rows: [u] } = await insertUser(pool, 'Legacy.Mixed@Example.test'); // legacy un-normalized row
    for (const variant of ['legacy.mixed@example.test', 'LEGACY.MIXED@EXAMPLE.TEST']) {
      expect((await userRepo.findByEmail(variant)).id).toBe(u.id);
    }
    expect((await register('legacy.mixed@example.test')).status).toBe(400); // no second account
  });

  test('OAuth-only account: a password registration with a variant is rejected; nothing is merged', async () => {
    const { rows: [g] } = await pool.query("INSERT INTO users (email, password_hash, full_name) VALUES ('google.user@example.test', NULL, 'G') RETURNING id");
    await pool.query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'google', 'google-f5-sub')", [g.id]);
    expect((await register('Google.User@Example.TEST')).status).toBe(400);
    await expect(pool.query("INSERT INTO users (email, password_hash) VALUES ('GOOGLE.USER@example.test', NULL)"))
      .rejects.toMatchObject({ code: '23505', constraint: 'uidx_users_email_normalized' });
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE lower(btrim(email)) = $1', ['google.user@example.test']);
    expect(rows).toEqual([{ id: g.id, password_hash: null }]); // untouched: no password silently added
    const { rows: links } = await pool.query('SELECT user_id FROM oauth_accounts');
    expect(links).toEqual([{ user_id: g.id }]);
  });
});
