/**
 * Shared helpers for the Phase 2 invitation API suites (not a test suite itself).
 */

const crypto = require('crypto');
const supertest = require('supertest');
const { Client } = require('pg');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const jwt = require('jsonwebtoken');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/** Authenticated request as `token` (organization comes from the URL on these routes). */
const api = (token) => {
  const req = supertest(app);
  const auth = (r) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: (url) => auth(req.get(url)),
    post: (url) => auth(req.post(url)),
    delete: (url) => auth(req.delete(url)),
  };
};

const invitationsUrl = (orgId) => `/api/organizations/${orgId}/invitations`;
const invitationUrl = (orgId, id) => `${invitationsUrl(orgId)}/${id}`;

/** Seed an invitation directly as the schema owner (bypasses RLS, like other fixtures). */
async function seedInvite(fields) {
  const row = {
    email: `seed-${crypto.randomBytes(4).toString('hex')}@documind.test`,
    role: 'member',
    token_hash: sha256(crypto.randomBytes(32).toString('base64url')),
    expires_at: new Date(Date.now() + 72 * 3600 * 1000),
    ...fields,
  };
  const cols = Object.keys(row);
  const { rows } = await pool.query(
    `INSERT INTO organization_invitations (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return rows[0];
}

async function getInvite(id) {
  const { rows } = await pool.query('SELECT * FROM organization_invitations WHERE id = $1', [id]);
  return rows[0];
}

async function countInvites(where = 'TRUE', params = []) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM organization_invitations WHERE ${where}`, params);
  return rows[0].n;
}

async function auditRows(action, resourceId) {
  const { rows } = await pool.query(
    'SELECT organization_id, actor_id, action, resource_id, metadata FROM audit_logs WHERE action = $1 AND resource_id = $2',
    [action, resourceId],
  );
  return rows;
}

async function setRole(orgId, userId, role) {
  await pool.query('UPDATE memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3', [role, orgId, userId]);
}

const RATE_LIMIT_PATTERNS = [
  'ratelimit:org:*', 'ratelimit:org-write:*', 'ratelimit:org-invite:*',
  'ratelimit:invite-preview:*', 'ratelimit:invite-accept:*',
];

/** Delete only this feature's rate-limit counters (never FLUSHALL). */
async function clearOrgRateLimits() {
  const redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
  const keys = (await Promise.all(RATE_LIMIT_PATTERNS.map(p => redis.keys(p)))).flat();
  if (keys.length) await redis.del(keys);
}

/**
 * Hold the per-organization lock from a connection outside the app pool, so requests queue
 * inside the admin transaction (after requireOrgAdmin) until release(). Idempotent release.
 */
async function holdOrgLock(orgId) {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgId]);
  let released = null;
  return {
    client,
    release: () => (released ||= (async () => {
      try { await client.query('COMMIT'); } finally { await client.end(); }
    })()),
  };
}

/**
 * Wait until `n` backends are blocked on the organization lock: lockOrganizationAsAdmin
 * ('SELECT status ...') or lockOrganizationForInvitationAcceptance ('SELECT name, status ...').
 */
async function waitForLockWaiters(n, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE 'SELECT %FROM organizations WHERE id = $1 FOR NO KEY UPDATE%'`,
    );
    if (rows[0].n >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} lock waiters, saw ${rows[0].n}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** supertest requests are lazy; .then() starts one without awaiting it. */
const start = (req) => req.then(res => res);

// ─── Phase 3 (invitee-facing) fixtures ───────────────────────────────────────

const newToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * Create a user directly (email stored exactly as given). `google: true` creates an
 * OAuth-only account (password_hash NULL + oauth_accounts row, migration 009).
 */
async function createUser(email, { fullName = 'Invitee User', google = false, status = 'active' } = {}) {
  const { rows: [user] } = await pool.query(
    'INSERT INTO users (email, password_hash, full_name, status) VALUES ($1, $2, $3, $4) RETURNING id, email',
    [email, google ? null : 'not-a-real-hash', fullName, status],
  );
  if (google) {
    await pool.query(
      "INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, 'google', $2)",
      [user.id, `google-${crypto.randomBytes(6).toString('hex')}`],
    );
  }
  return { ...user, token: jwt.sign({ userId: user.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) };
}

/** Seed an invitation whose raw token is known to the test (only its hash is stored). */
async function seedInviteWithToken(fields) {
  const token = newToken();
  const row = await seedInvite({ ...fields, token_hash: sha256(token) });
  return { row, token };
}

async function membershipOf(orgId, userId) {
  const { rows } = await pool.query(
    'SELECT id, role, status, created_at FROM memberships WHERE organization_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  return rows;
}

/** Invariant: every accepted invitation has an active membership for its accepter, and vice versa per test. */
async function inconsistentAcceptedInvitations() {
  const { rows } = await pool.query(
    `SELECT i.id FROM organization_invitations i
     LEFT JOIN memberships m ON m.organization_id = i.organization_id AND m.user_id = i.accepted_by
     WHERE i.status = 'accepted' AND (i.accepted_by IS NULL OR m.status IS DISTINCT FROM 'active')`,
  );
  return rows;
}

const PUBLIC_FIELDS = [
  'accepted_at', 'accepted_by', 'created_at', 'email', 'expires_at', 'id', 'invited_by',
  'organization_id', 'revoked_at', 'revoked_by', 'role', 'status', 'updated_at',
];

module.exports = {
  sha256,
  api,
  invitationsUrl,
  invitationUrl,
  seedInvite,
  getInvite,
  countInvites,
  auditRows,
  setRole,
  clearOrgRateLimits,
  holdOrgLock,
  waitForLockWaiters,
  start,
  PUBLIC_FIELDS,
  newToken,
  createUser,
  seedInviteWithToken,
  membershipOf,
  inconsistentAcceptedInvitations,
};
