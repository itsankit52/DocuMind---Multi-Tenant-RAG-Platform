/**
 * Phase 3.3 WP3 (F7) — invitation acceptance share-locks the inviter's membership and user rows.
 *
 * Application writers serialize on the organization row; these tests use separate, real
 * PostgreSQL connections that bypass that convention (manual SQL / external clients).
 * Synchronization is by observed lock waits (pg_stat_activity + pg_blocking_pids), never sleeps.
 *   A. acceptance holds the inviter rows → an external demotion waits until it commits
 *   B. an external demotion / removal / account disable holds the row first → acceptance waits,
 *      re-checks the committed row and fails with the generic 404; a rollback lets it succeed
 *   D. a demotion through the real members API queues on the organization lock (unchanged)
 *   F. an external writer that also wants the organization row → deadlock (40P01): the victim
 *      is rolled back with nothing persisted; acceptance's response stays generic
 *   E. self-invitation (inviter = invitee) is covered by invitations_accept_security "F."
 */

const { Client } = require('pg');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const h = require('../streaming/stream.helpers');
const {
  api, invitationsUrl, getInvite, clearOrgRateLimits, start, createUser, membershipOf, waitForLockWaiters,
} = require('./invitation.helpers');

const INVALID = { status: 'fail', message: 'Invitation not found or no longer valid.' };
let orgA;
let invitee;
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

/** Poll until a backend is lock-waiting on a statement LIKE `pattern` (optionally blocked by `blocker`). */
async function waitForBlocked(pattern, blocker, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [pattern]);
    const hit = rows.find(r => blocker === undefined || r.blockers.includes(blocker));
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no backend blocked on ${pattern}`);
    await new Promise(r => setTimeout(r, 10)); // poll interval for an observed condition, not a timing assumption
  }
}

/** 'locked' if `lockClause` on the row cannot be taken immediately, else 'free'. */
async function probe(sql, params) {
  const c = await connect();
  await c.query('BEGIN');
  try {
    await c.query(`${sql} NOWAIT`, params);
    return 'free';
  } catch (e) {
    if (e.code === '55P03') return 'locked';
    throw e;
  } finally {
    await c.query('ROLLBACK');
  }
}

const INVITEE_LOCK = 'SELECT id, role, status FROM memberships%FOR UPDATE%';
const INVITER_LOCK = '%FOR SHARE OF m, u%';
const accept = (token) => start(api(invitee.token).post('/api/invitations/accept').send({ token }));
const inviterId = () => orgA.users.admin.id;

async function inviteViaApi(role = 'member') {
  const res = await api(orgA.users.admin.token).post(invitationsUrl(orgA.orgId)).send({ email: invitee.email, role });
  expect(res.status).toBe(201);
  return res.body.data;
}
async function auditCount(invitationId) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'INVITATION_ACCEPT' AND resource_id = $1", [invitationId]);
  return rows[0].n;
}

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('lock-a', ['admin', 'member']);
  invitee = await createUser('lock-invitee@documind.test');
});

afterEach(async () => {
  while (open.length) {
    const c = open.pop();
    try { await c.query('ROLLBACK'); } catch { /* not in a transaction */ }
    await c.end().catch(() => {});
  }
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

test('A. acceptance holds org → invitation → inviter rows (shared) before the invitee row; an external demotion waits', async () => {
  const { invitation, token } = await inviteViaApi('viewer');
  // park the acceptance at lock step 4 (invitee membership) by holding that row elsewhere
  await pool.query("INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'member', 'removed')", [orgA.orgId, invitee.id]);
  const holder = await connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE', [orgA.orgId, invitee.id]);

  const res = accept(token);
  const acceptance = await waitForBlocked(INVITEE_LOCK, holder.pid);

  // lock order evidence at step 4: org + invitation exclusive, inviter rows share-locked only
  expect(await probe('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgA.orgId])).toBe('locked');
  expect(await probe('SELECT 1 FROM organization_invitations WHERE id = $1 FOR UPDATE', [invitation.id])).toBe('locked');
  for (const [table, where, params] of [
    ['memberships', 'organization_id = $1 AND user_id = $2', [orgA.orgId, inviterId()]],
    ['users', 'id = $1', [inviterId()]],
  ]) {
    expect(await probe(`SELECT 1 FROM ${table} WHERE ${where} FOR NO KEY UPDATE`, params)).toBe('locked');
    expect(await probe(`SELECT 1 FROM ${table} WHERE ${where} FOR SHARE`, params)).toBe('free'); // not exclusive
  }

  // the external demotion blocks on the acceptance (not on the holder)
  const external = await connect();
  await external.query('BEGIN');
  const demotion = external.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, inviterId()]);
  const blocked = await waitForBlocked("UPDATE memberships SET role = 'member'%", acceptance.pid);
  expect(blocked.blockers).toEqual([acceptance.pid]);

  await holder.query('COMMIT');
  expect((await res).status).toBe(200);
  expect((await demotion).rowCount).toBe(1); // proceeds only after the acceptance committed
  await external.query('COMMIT');

  expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'viewer', status: 'active' })]);
  expect(await membershipOf(orgA.orgId, inviterId())).toEqual([expect.objectContaining({ role: 'member', status: 'active' })]);
  expect((await getInvite(invitation.id)).status).toBe('accepted');
  expect(await auditCount(invitation.id)).toBe(1);
});

describe('B/C. an external writer that holds the inviter row first', () => {
  const WRITES = [
    ['membership demoted', "UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2", () => [orgA.orgId, inviterId()]],
    ['membership removed', "UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2", () => [orgA.orgId, inviterId()]],
    ['account disabled', "UPDATE users SET status = 'disabled' WHERE id = $1", () => [inviterId()]],
  ];

  test.each(WRITES)('%s and committed → acceptance waits, sees it, generic 404, nothing written', async (_l, sql, params) => {
    const { invitation, token } = await inviteViaApi();
    const external = await connect();
    await external.query('BEGIN');
    await external.query(sql, params());

    const res = accept(token);
    await waitForBlocked(INVITER_LOCK, external.pid);
    await external.query('COMMIT');

    const r = await res;
    expect(r.status).toBe(404);
    expect(r.body).toEqual(INVALID);
    expect((await getInvite(invitation.id)).status).toBe('pending');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    expect(await auditCount(invitation.id)).toBe(0);
  });

  test.each(WRITES)('%s but rolled back → acceptance waits, then succeeds', async (_l, sql, params) => {
    const { invitation, token } = await inviteViaApi();
    const external = await connect();
    await external.query('BEGIN');
    await external.query(sql, params());

    const res = accept(token);
    await waitForBlocked(INVITER_LOCK, external.pid);
    await external.query('ROLLBACK');

    expect((await res).status).toBe(200);
    expect((await getInvite(invitation.id)).status).toBe('accepted');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ status: 'active' })]);
  });
});

test('D. a demotion through the real members API still serializes on the organization lock', async () => {
  // the inviter is a second admin; the first admin demotes them while the acceptance is parked
  await pool.query("UPDATE memberships SET role = 'admin' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, orgA.users.member.id]);
  const created = await api(orgA.users.member.token).post(invitationsUrl(orgA.orgId)).send({ email: invitee.email, role: 'member' });
  expect(created.status).toBe(201);
  await pool.query("INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'member', 'removed')", [orgA.orgId, invitee.id]);
  const holder = await connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE', [orgA.orgId, invitee.id]);

  const res = accept(created.body.data.token);
  await waitForBlocked(INVITEE_LOCK, holder.pid);
  const demote = start(api(orgA.users.admin.token).post(`/api/organizations/${orgA.orgId}/members`)
    .send({ email: 'lock-a_member@documind.test', role: 'viewer' }));
  await waitForLockWaiters(1); // queued on the organization row, behind the acceptance

  await holder.query('COMMIT');
  expect((await res).status).toBe(200);
  expect((await demote).status).toBeLessThan(300);
  expect((await getInvite(created.body.data.invitation.id)).status).toBe('accepted');
  expect(await membershipOf(orgA.orgId, orgA.users.member.id)).toEqual([expect.objectContaining({ role: 'viewer' })]);
});

describe('F. deadlock with an external writer that also locks the organization row', () => {
  async function deadlock(externalDeadlockTimeout) {
    const { invitation, token } = await inviteViaApi();
    const external = await connect();
    await external.query('BEGIN');
    // the backend with the shorter deadlock_timeout runs the deadlock check first and is the victim
    await external.query(`SET LOCAL deadlock_timeout = '${externalDeadlockTimeout}'`);
    await external.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, inviterId()]);
    const res = accept(token);
    const acceptance = await waitForBlocked(INVITER_LOCK, external.pid);
    const orgLock = external.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', [orgA.orgId])
      .then(() => 'granted', e => e.code);
    await waitForBlocked('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE', acceptance.pid);
    return { invitation, res, external, orgLock };
  }

  test('acceptance is the victim (40P01): rolled back, generic 500 without details, external commits', async () => {
    const { invitation, res, external, orgLock } = await deadlock('30s');
    const r = await res;
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ status: 'error', message: 'Internal server error' }); // AppError.from: generic, no 40P01 detail
    expect(await orgLock).toBe('granted');
    await external.query('COMMIT');
    expect((await getInvite(invitation.id)).status).toBe('pending');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
    expect(await auditCount(invitation.id)).toBe(0);
  });

  test('the external writer is the victim (40P01): its demotion rolls back, acceptance succeeds', async () => {
    const { invitation, res, external, orgLock } = await deadlock('50ms');
    expect(await orgLock).toBe('40P01');
    await external.query('ROLLBACK');
    expect((await res).status).toBe(200);
    expect((await getInvite(invitation.id)).status).toBe('accepted');
    expect(await membershipOf(orgA.orgId, inviterId())).toEqual([expect.objectContaining({ role: 'admin' })]);
  });
});

test('preview takes no row locks on the inviter (still read-only and lock-free)', async () => {
  const { token } = await inviteViaApi();
  const external = await connect();
  await external.query('BEGIN');
  await external.query("UPDATE memberships SET role = 'admin' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, inviterId()]);
  // an uncommitted writer on the inviter row does not block preview
  const r = await api(invitee.token).post('/api/invitations/preview').send({ token });
  expect(r.status).toBe(200);
  await external.query('ROLLBACK');
});
