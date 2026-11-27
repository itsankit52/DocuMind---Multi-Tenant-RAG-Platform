/**
 * Organization onboarding — Phase 0 security hardening:
 *  - malformed organization IDs on organization routes are a 400, never a PostgreSQL 500
 *  - concurrent admin demotions can never leave an active organization without an admin
 *    (requests are forced to queue on the organization lock, then released deterministically)
 *  - organization creation and its ORG_CREATE audit entry commit or roll back together
 *  - organization routes are rate limited per user (Redis)
 */

const supertest = require('supertest');
const { Client } = require('pg');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const auditRepo = require('../../src/repositories/audit.repository');
const orgRepo = require('../../src/repositories/org.repository');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');

const api = (token) => {
  const req = supertest(app);
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);
  return {
    get: (url) => auth(req.get(url)),
    post: (url) => auth(req.post(url)),
  };
};

let redis;

async function clearOrgRateLimits() {
  const keys = [...await redis.keys('ratelimit:org:*'), ...await redis.keys('ratelimit:org-write:*')];
  if (keys.length) await redis.del(keys);
}

async function activeAdminCount(orgId) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM memberships WHERE organization_id = $1 AND role = 'admin' AND status = 'active'",
    [orgId],
  );
  return rows[0].n;
}

async function setRole(orgId, userId, role) {
  await pool.query('UPDATE memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3', [role, orgId, userId]);
}

/**
 * Hold the per-organization membership lock from a connection outside the app's pool, so
 * requests are forced to queue inside setMemberRole (past requireOrgAdmin) until release().
 */
async function holdOrgLock(orgId) {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
  let released = null;
  return {
    client,
    // Idempotent, so a safety timer and the test's finally can both call it
    release: () => (released ||= (async () => {
      try { await client.query('COMMIT'); } finally { await client.end(); }
    })()),
  };
}

/** Wait until `n` backends are blocked on the organization lock taken by setMemberRole. */
async function waitForLockWaiters(n, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE 'SELECT status FROM organizations WHERE id = $1 FOR NO KEY UPDATE%'`,
    );
    if (rows[0].n >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} lock waiters, saw ${rows[0].n}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** supertest requests are lazy; .then() starts one without awaiting it. */
const start = (req) => req.then(res => res);

beforeAll(async () => {
  await h.truncateAll();
  redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
  await clearOrgRateLimits();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearOrgRateLimits();
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

describe('1. Organization ID validation', () => {
  let org;
  beforeAll(async () => {
    org = await h.createOrgWithUsers('hardening-uuid', ['admin']);
  });

  test.each([
    ['GET', '/api/organizations/not-a-uuid/members'],
    ['POST', '/api/organizations/not-a-uuid/members'],
    ['POST', '/api/organizations/not-a-uuid/select'],
    ['GET', "/api/organizations/1'%20OR%20'1'='1/members"],
    ['GET', '/api/organizations/00000000-0000-0000-0000-00000000000g/members'],
  ])('%s %s returns 400, not 500', async (method, url) => {
    const client = api(org.users.admin.token);
    const res = method === 'GET'
      ? await client.get(url)
      : await client.post(url).send({ email: 'x@documind.test', role: 'member' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Organization ID must be a valid UUID.');
  });

  test('a well-formed but unknown organization ID is still a 403 for admin routes', async () => {
    const res = await api(org.users.admin.token).get('/api/organizations/00000000-0000-4000-8000-000000000000/members');
    expect(res.status).toBe(403);
  });

  test('a valid organization ID keeps working', async () => {
    const res = await api(org.users.admin.token).get(`/api/organizations/${org.orgId}/members`);
    expect(res.status).toBe(200);
  });

  test('unauthenticated requests are rejected (401) before ID validation', async () => {
    const res = await supertest(app).get('/api/organizations/not-a-uuid/members');
    expect(res.status).toBe(401);
  });
});

describe('2. Last-admin protection under concurrency', () => {
  let org;
  let emails;
  beforeAll(async () => {
    // admin + member users; the member is promoted to a second admin per test
    org = await h.createOrgWithUsers('hardening-race', ['admin', 'member']);
    emails = { admin: 'hardening-race_admin@documind.test', member: 'hardening-race_member@documind.test' };
  });

  beforeEach(async () => {
    await setRole(org.orgId, org.users.admin.id, 'admin');
    await setRole(org.orgId, org.users.member.id, 'admin');
  });

  // Deterministic concurrency: both requests pass requireOrgAdmin (both are admins at that
  // point) and are proven to be queued on the organization lock before it is released.

  test('two admins demoting each other while queued on the lock: one wins, the other is refused by the in-lock actor re-check (403)', async () => {
    const lock = await holdOrgLock(org.orgId);
    let a; let b;
    try {
      a = start(api(org.users.admin.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'member' }));
      b = start(api(org.users.member.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.admin, role: 'member' }));
      await waitForLockWaiters(2);
    } finally {
      await lock.release();
    }
    const statuses = [(await a).status, (await b).status].sort();
    // Never 409 and never two 201s: the loser was demoted by the winner while it waited
    expect(statuses).toEqual([201, 403]);
    expect(await activeAdminCount(org.orgId)).toBe(1);
  });

  test('two admins demoting themselves while queued on the lock: one wins, the other gets 409', async () => {
    const lock = await holdOrgLock(org.orgId);
    let a; let b;
    try {
      a = start(api(org.users.admin.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.admin, role: 'viewer' }));
      b = start(api(org.users.member.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'viewer' }));
      await waitForLockWaiters(2);
    } finally {
      await lock.release();
    }
    expect([(await a).status, (await b).status].sort()).toEqual([201, 409]);
    expect(await activeAdminCount(org.orgId)).toBe(1);
  });

  test('an actor demoted while their request waits on the lock is refused (403) and nothing changes', async () => {
    await setRole(org.orgId, org.users.member.id, 'admin'); // second admin = the actor
    const lock = await holdOrgLock(org.orgId);
    let req;
    try {
      // The actor (still an admin, so past requireOrgAdmin) tries to demote the other admin
      req = start(api(org.users.member.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.admin, role: 'viewer' }));
      await waitForLockWaiters(1);
      // Demote the actor inside the lock holder's transaction, after they passed requireOrgAdmin
      await lock.client.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [org.orgId, org.users.member.id]);
    } finally {
      await lock.release();
    }
    const res = await req;
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [org.orgId, org.users.admin.id]);
    expect(rows[0].role).toBe('admin');
  });

  test('an organization suspended while a request waits on the lock is refused (403) inside the transaction', async () => {
    const other = await h.createOrgWithUsers('hardening-suspend-race', ['admin', 'member']);
    const lock = await holdOrgLock(other.orgId);
    let req;
    try {
      req = start(api(other.users.admin.token).post(`/api/organizations/${other.orgId}/members`)
        .send({ email: 'hardening-suspend-race_member@documind.test', role: 'admin' }));
      await waitForLockWaiters(1);
      await lock.client.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [other.orgId]);
    } finally {
      await lock.release();
    }
    expect((await req).status).toBe(403);
    const { rows } = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [other.orgId, other.users.member.id]);
    expect(rows[0].role).toBe('member');
  });

  test('a request that cannot get the lock within lock_timeout gets a 409 retry error and changes nothing', async () => {
    const original = orgRepo.memberLockTimeoutMs;
    orgRepo.memberLockTimeoutMs = 300;
    const lock = await holdOrgLock(org.orgId);
    // If lock_timeout regressed, the request would wait forever: release after 3s so the
    // test fails cleanly (request then succeeds → not 409) instead of hanging the suite.
    const safety = setTimeout(() => { lock.release(); }, 3000);
    let res;
    try {
      res = await api(org.users.admin.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'viewer' });
    } finally {
      clearTimeout(safety);
      orgRepo.memberLockTimeoutMs = original;
      await lock.release();
    }
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Another change to this organization is in progress. Please retry.');
    const { rows } = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [org.orgId, org.users.member.id]);
    expect(rows[0].role).toBe('admin');
  });

  test('setMemberRole runs READ COMMITTED with a bounded lock_timeout, on one connection', async () => {
    const seen = [];
    const realConnect = pool.connect.bind(pool);
    jest.spyOn(pool, 'connect').mockImplementation(async (...args) => {
      // pool.query() checks out clients via connect(callback): pass those through untouched
      if (typeof args[0] === 'function') return realConnect(...args);
      const client = await realConnect();
      const realQuery = client.query;
      client.query = function trackedQuery(text, ...rest) {
        seen.push(typeof text === 'string' ? text : text.text);
        if (typeof text === 'string' && text.includes('lock_timeout')) {
          return realQuery.call(this, text, ...rest).then((r) => {
            seen.push(`params:${JSON.stringify(rest[0])}`);
            return r;
          });
        }
        return realQuery.call(this, text, ...rest);
      };
      const release = client.release.bind(client);
      client.release = (...args) => { client.query = realQuery; return release(...args); };
      return client;
    });

    const res = await api(org.users.admin.token).post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'admin' });
    expect(res.status).toBe(201);
    const begin = seen.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(seen[begin + 1]).toContain("set_config('lock_timeout'");
    expect(seen[begin + 2]).toBe('params:["5000ms"]');
    expect(seen[begin + 3]).toContain('FOR NO KEY UPDATE');
    expect(seen).toContain('COMMIT');
  });

  test('a demoted admin can no longer change roles (pre-check in requireOrgAdmin)', async () => {
    const demote = await api(org.users.admin.token)
      .post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'member' });
    expect(demote.status).toBe(201);

    const attempt = await api(org.users.member.token)
      .post(`/api/organizations/${org.orgId}/members`).send({ email: emails.admin, role: 'member' });
    expect(attempt.status).toBe(403);
    expect(await activeAdminCount(org.orgId)).toBe(1);
  });

  test('the last admin still cannot be demoted sequentially (409), and promotion still works', async () => {
    await setRole(org.orgId, org.users.member.id, 'member');
    const last = await api(org.users.admin.token)
      .post(`/api/organizations/${org.orgId}/members`).send({ email: emails.admin, role: 'member' });
    expect(last.status).toBe(409);
    expect(await activeAdminCount(org.orgId)).toBe(1);

    const promote = await api(org.users.admin.token)
      .post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'admin' });
    expect(promote.status).toBe(201);
    expect(await activeAdminCount(org.orgId)).toBe(2);
  });

  test('non-admins are still refused (403) and roles stay unchanged', async () => {
    await setRole(org.orgId, org.users.member.id, 'member');
    const res = await api(org.users.member.token)
      .post(`/api/organizations/${org.orgId}/members`).send({ email: emails.member, role: 'admin' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [org.orgId, org.users.member.id]);
    expect(rows[0].role).toBe('member');
  });

  test('role changes in a suspended organization are refused (pre-check in requireOrgAdmin)', async () => {
    const other = await h.createOrgWithUsers('hardening-suspended', ['admin', 'member']);
    await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [other.orgId]);
    const res = await api(other.users.admin.token)
      .post(`/api/organizations/${other.orgId}/members`).send({ email: 'hardening-suspended_member@documind.test', role: 'admin' });
    expect(res.status).toBe(403);
  });
});

describe('3. Organization creation is atomic with its audit entry', () => {
  let user;
  beforeAll(async () => {
    const org = await h.createOrgWithUsers('hardening-create', ['admin']);
    user = org.users.admin;
  });

  test('creation writes the org, the admin membership and ORG_CREATE together', async () => {
    const res = await api(user.token).post('/api/organizations').send({ name: 'Atomic Org', slug: 'atomic-org' });
    expect(res.status).toBe(201);
    const orgId = res.body.data.org.id;

    const { rows: m } = await pool.query('SELECT role, status FROM memberships WHERE organization_id = $1 AND user_id = $2', [orgId, user.id]);
    expect(m).toEqual([{ role: 'admin', status: 'active' }]);
    const { rows: a } = await pool.query("SELECT actor_id, metadata FROM audit_logs WHERE organization_id = $1 AND action = 'ORG_CREATE'", [orgId]);
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe(user.id);
    expect(a[0].metadata).toEqual({ name: 'Atomic Org', slug: 'atomic-org' });
  });

  test('if the audit insert fails, the organization and membership are rolled back', async () => {
    // Fail inside the same transaction client the repository passes in
    const spy = jest.spyOn(auditRepo, 'log').mockImplementationOnce(async (_entry, db) => {
      expect(db).not.toBe(pool); // must be the transaction client, not the shared pool
      await db.query('SELECT 1/0');
    });

    const res = await api(user.token).post('/api/organizations').send({ name: 'Rollback Org', slug: 'rollback-org' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.body.message).not.toMatch(/division/i);

    const { rows: orgs } = await pool.query("SELECT id FROM organizations WHERE slug = 'rollback-org'");
    expect(orgs).toHaveLength(0);
    const { rows: members } = await pool.query(
      "SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE o.slug = 'rollback-org'",
    );
    expect(members).toHaveLength(0);

    // The slug is free again once the failure is gone
    const retry = await api(user.token).post('/api/organizations').send({ name: 'Rollback Org', slug: 'rollback-org' });
    expect(retry.status).toBe(201);
  });
});

describe('4. Organization route rate limiting', () => {
  let org;
  let other;
  beforeAll(async () => {
    org = await h.createOrgWithUsers('hardening-limit', ['admin']);
    other = await h.createOrgWithUsers('hardening-limit-other', ['admin']);
  });

  test('requests count against a per-user Redis budget', async () => {
    const res = await api(org.users.admin.token).get('/api/organizations/my-organizations');
    expect(res.status).toBe(200);
    expect(Number(await redis.get(`ratelimit:org:${org.users.admin.id}`))).toBe(1);
  });

  test('an exhausted general budget returns 429 on organization routes', async () => {
    await redis.set(`ratelimit:org:${org.users.admin.id}`, '100000', { EX: 60 });
    const list = await api(org.users.admin.token).get('/api/organizations/my-organizations');
    expect(list.status).toBe(429);
    const members = await api(org.users.admin.token).get(`/api/organizations/${org.orgId}/members`);
    expect(members.status).toBe(429);
  });

  test('budgets are per user: another user is unaffected', async () => {
    await redis.set(`ratelimit:org:${org.users.admin.id}`, '100000', { EX: 60 });
    const res = await api(other.users.admin.token).get('/api/organizations/my-organizations');
    expect(res.status).toBe(200);
  });

  test('an exhausted write budget blocks creation and member changes but not reads', async () => {
    await redis.set(`ratelimit:org-write:${org.users.admin.id}`, '100000', { EX: 60 });

    const create = await api(org.users.admin.token).post('/api/organizations').send({ name: 'Limited', slug: 'limited-org' });
    expect(create.status).toBe(429);
    const { rows } = await pool.query("SELECT 1 FROM organizations WHERE slug = 'limited-org'");
    expect(rows).toHaveLength(0);

    const member = await api(org.users.admin.token)
      .post(`/api/organizations/${org.orgId}/members`).send({ email: 'hardening-limit_admin@documind.test', role: 'admin' });
    expect(member.status).toBe(429);

    const read = await api(org.users.admin.token).get('/api/organizations/my-organizations');
    expect(read.status).toBe(200);
  });

  test('the organization limiter does not consume the auth limiter budget', async () => {
    const keysBefore = await redis.keys('ratelimit:auth:*');
    await api(org.users.admin.token).get('/api/organizations/my-organizations');
    expect(await redis.keys('ratelimit:auth:*')).toEqual(keysBefore);
  });
});
