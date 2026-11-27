/**
 * Phase 3 — invitation acceptance: atomicity, deterministic concurrency, tenant context,
 * token confidentiality and rate limiting.
 *
 * Concurrency tests hold the per-organization lock from a separate connection, wait until
 * the requests are queued on it (pg_stat_activity), mutate state if needed, then release.
 */

const { pool } = require('../../src/db');
const logger = require('../../src/observability/logger');
const orgRepo = require('../../src/repositories/org.repository');
const invitationRepo = require('../../src/repositories/invitation.repository');
const auditRepo = require('../../src/repositories/audit.repository');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, invitationUrl, getInvite, countInvites, auditRows, clearOrgRateLimits,
  holdOrgLock, waitForLockWaiters, start, newToken, createUser, membershipOf,
  inconsistentAcceptedInvitations,
} = require('./invitation.helpers');

const INVALID = { status: 'fail', message: 'Invitation not found or no longer valid.' };
let orgA;
let orgB;
let invitee;

const accept = (token, userToken = invitee.token) => api(userToken).post('/api/invitations/accept').send({ token });
const preview = (token, userToken = invitee.token) => api(userToken).post('/api/invitations/preview').send({ token });

async function invite(email = 'invitee@documind.test', role = 'member', org = orgA) {
  const res = await api(org.users.admin.token).post(invitationsUrl(org.orgId)).send({ email, role });
  expect(res.status).toBe(201);
  return res.body.data;
}

/** Assert nothing about the acceptance persisted. */
async function expectUntouched(invitationId, userId = invitee.id, org = orgA) {
  expect(await membershipOf(org.orgId, userId)).toEqual([]);
  const row = await getInvite(invitationId);
  expect(row).toMatchObject({ status: 'pending', accepted_by: null, accepted_at: null });
  expect(await auditRows('INVITATION_ACCEPT', invitationId)).toEqual([]);
}

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('acc-sec-a', ['admin', 'member']);
  orgB = await h.createOrgWithUsers('acc-sec-b', ['admin']);
  invitee = await createUser('invitee@documind.test');
});

afterEach(async () => {
  jest.restoreAllMocks();
  expect(await inconsistentAcceptedInvitations()).toEqual([]);
});

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Atomicity (rollback)', () => {
  test('membership write fails → 500, nothing persisted', async () => {
    const { token, invitation } = await invite();
    jest.spyOn(orgRepo, 'activateMembershipFromInvitation').mockRejectedValueOnce(new Error('membership insert failed'));
    const res = await accept(token);
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/membership insert failed/);
    await expectUntouched(invitation.id);
  });

  // Observations are RECORDED inside the mocks and asserted afterwards: an expect() thrown
  // inside a mock would only become the 500 the test expects, so it could never fail.
  const insideTransaction = async (client) => {
    const { rows: [ctx] } = await client.query(
      `SELECT current_user AS role, current_setting('app.current_tenant', true) AS tenant,
              (SELECT count(*)::int FROM memberships WHERE organization_id = $1 AND user_id = $2) AS memberships`,
      [orgA.orgId, invitee.id],
    );
    return ctx;
  };

  test('invitation update fails AFTER the membership was written → membership rolled back', async () => {
    const { token, invitation } = await invite();
    const spy = jest.spyOn(orgRepo, 'activateMembershipFromInvitation');
    const seen = [];
    jest.spyOn(invitationRepo, 'markAccepted').mockImplementationOnce(async (client) => {
      seen.push({ upsertCalls: spy.mock.calls.length, ...(await insideTransaction(client)) });
      await client.query('SELECT 1/0');
    });
    expect((await accept(token)).status).toBe(500);
    // The failure really happened after the membership row existed in this transaction...
    expect(seen).toEqual([{ upsertCalls: 1, role: 'documind_app', tenant: orgA.orgId, memberships: 1 }]);
    // ...and nothing of it was persisted.
    await expectUntouched(invitation.id);
  });

  test('audit insert fails → membership and acceptance rolled back; the audit used the transaction client', async () => {
    const { token, invitation } = await invite();
    const seen = [];
    jest.spyOn(auditRepo, 'log').mockImplementationOnce(async (_entry, db) => {
      seen.push(await insideTransaction(db));
      await db.query('SELECT 1/0');
    });
    expect((await accept(token)).status).toBe(500);
    // Same connection and transaction as the membership write (it sees the uncommitted row)
    expect(seen).toEqual([{ role: 'documind_app', tenant: orgA.orgId, memberships: 1 }]);
    await expectUntouched(invitation.id);
  });

  test('the invitation is accepted exactly when the membership exists (invariant after a success)', async () => {
    const { token, invitation } = await invite('invitee@documind.test', 'viewer');
    expect((await accept(token)).status).toBe(200);
    expect((await getInvite(invitation.id)).status).toBe('accepted');
    expect(await membershipOf(orgA.orgId, invitee.id)).toHaveLength(1);
    expect(await auditRows('INVITATION_ACCEPT', invitation.id)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Concurrency (deterministic, lock-barrier based)', () => {
  let lock;
  afterEach(async () => { if (lock) await lock.release(); lock = null; });

  test('A. the same token accepted twice concurrently: exactly one success, one membership, one audit', async () => {
    const { token, invitation } = await invite();
    lock = await holdOrgLock(orgA.orgId);
    const a = start(accept(token));
    const b = start(accept(token));
    await waitForLockWaiters(2);
    await lock.release();

    const statuses = (await Promise.all([a, b])).map(r => r.status).sort();
    expect(statuses).toEqual([200, 404]);
    expect(await membershipOf(orgA.orgId, invitee.id)).toHaveLength(1);
    expect((await getInvite(invitation.id)).status).toBe('accepted');
    expect(await auditRows('INVITATION_ACCEPT', invitation.id)).toHaveLength(1);
  });

  test('B1. accept queued before revoke: acceptance wins, revoke cannot reverse it', async () => {
    const { token, invitation } = await invite();
    lock = await holdOrgLock(orgA.orgId);
    const acc = start(accept(token));
    await waitForLockWaiters(1);
    const rev = start(api(orgA.users.admin.token).delete(invitationUrl(orgA.orgId, invitation.id)));
    await waitForLockWaiters(2);
    await lock.release();

    const [accRes, revRes] = await Promise.all([acc, rev]);
    expect(accRes.status).toBe(200);
    expect(revRes.status).toBe(409);
    expect(revRes.body.message).toBe('This invitation has already been accepted.');
    expect((await getInvite(invitation.id)).status).toBe('accepted');
    expect(await membershipOf(orgA.orgId, invitee.id)).toHaveLength(1);
  });

  test('B2. revoke queued before accept: revocation wins, acceptance fails, nothing created', async () => {
    const { token, invitation } = await invite();
    lock = await holdOrgLock(orgA.orgId);
    const rev = start(api(orgA.users.admin.token).delete(invitationUrl(orgA.orgId, invitation.id)));
    await waitForLockWaiters(1);
    const acc = start(accept(token));
    await waitForLockWaiters(2);
    await lock.release();

    const [revRes, accRes] = await Promise.all([rev, acc]);
    expect(revRes.status).toBe(200);
    expect(accRes.body).toEqual(INVALID);
    expect((await getInvite(invitation.id)).status).toBe('revoked');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
  });

  test('B3. resend queued before accept: the old token is invalid once acceptance gets the lock', async () => {
    const { token, invitation } = await invite();
    lock = await holdOrgLock(orgA.orgId);
    const resend = start(api(orgA.users.admin.token).post(`${invitationUrl(orgA.orgId, invitation.id)}/resend`));
    await waitForLockWaiters(1);
    const acc = start(accept(token));
    await waitForLockWaiters(2);
    await lock.release();

    const [resendRes, accRes] = await Promise.all([resend, acc]);
    expect(resendRes.status).toBe(200);
    expect(accRes.body).toEqual(INVALID);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
  });

  test.each([
    ['C. inviter demoted', (c) => c.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, orgA.users.admin.id])],
    ['C. inviter removed', (c) => c.query("UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2", [orgA.orgId, orgA.users.admin.id])],
    ['D. organization suspended', (c) => c.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [orgA.orgId])],
  ])('%s while the acceptance is queued on the lock → 404, nothing created', async (_label, mutate) => {
    const { token, invitation } = await invite();
    lock = await holdOrgLock(orgA.orgId);
    const acc = start(accept(token));
    await waitForLockWaiters(1); // the request passed every earlier stage and waits on the lock
    await mutate(lock.client);
    await lock.release();

    expect((await acc).body).toEqual(INVALID);
    await expectUntouched(invitation.id);
  });

  test('E. membership created by an admin while the acceptance is queued → 409, role unchanged', async () => {
    const { token, invitation } = await invite('invitee@documind.test', 'admin');
    lock = await holdOrgLock(orgA.orgId);
    const acc = start(accept(token));
    await waitForLockWaiters(1);
    await lock.client.query("INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'viewer', 'active')", [orgA.orgId, invitee.id]);
    await lock.release();

    const res = await acc;
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ORGANIZATION_MEMBER');
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'viewer', status: 'active' })]);
    expect((await getInvite(invitation.id)).status).toBe('pending');
  });

  test('E/F. invitations for the same user from two organizations accepted concurrently: one membership each', async () => {
    const a = await invite('invitee@documind.test', 'member', orgA);
    const b = await invite('invitee@documind.test', 'viewer', orgB);
    const [resA, resB] = await Promise.all([accept(a.token), accept(b.token)]);
    expect([resA.status, resB.status]).toEqual([200, 200]);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'member' })]);
    expect(await membershipOf(orgB.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'viewer' })]);
  });

  test('F. the last admin accepting an invitation to their own organization keeps admin (409)', async () => {
    const { token } = await invite('acc-sec-a_admin@documind.test', 'viewer');
    const res = await accept(token, orgA.users.admin.token);
    expect(res.status).toBe(409);
    expect(await membershipOf(orgA.orgId, orgA.users.admin.id)).toEqual([expect.objectContaining({ role: 'admin', status: 'active' })]);
    expect(await orgRepo.countActiveAdmins(orgA.orgId)).toBe(1);
  });

  test('a held organization lock beyond lock_timeout → retryable 409, nothing created', async () => {
    const { token, invitation } = await invite();
    const original = orgRepo.memberLockTimeoutMs;
    orgRepo.memberLockTimeoutMs = 300;
    lock = await holdOrgLock(orgA.orgId);
    const safety = setTimeout(() => lock && lock.release(), 5000);
    try {
      const res = await accept(token);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Another change to this organization is in progress. Please retry.');
    } finally {
      clearTimeout(safety);
      orgRepo.memberLockTimeoutMs = original;
    }
    await lock.release();
    await expectUntouched(invitation.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Tenant context, lock order and isolation', () => {
  test('only the token→organization lookup runs outside the tenant; everything else runs as documind_app under RLS', async () => {
    const seen = [];
    const wrap = (repo, name) => {
      const original = repo[name].bind(repo);
      jest.spyOn(repo, name).mockImplementation(async (db, ...args) => {
        const { rows: [ctx] } = await db.query("SELECT current_user AS role, current_setting('app.current_tenant', true) AS tenant");
        seen.push({ name, ...ctx });
        return original(db, ...args);
      });
    };
    wrap(invitationRepo, 'findOrganizationIdByTokenHash');
    wrap(orgRepo, 'lockOrganizationForInvitationAcceptance');
    wrap(invitationRepo, 'findByTokenHash');
    wrap(orgRepo, 'findMembershipForUpdate');
    wrap(orgRepo, 'activateMembershipFromInvitation');
    wrap(invitationRepo, 'markAccepted');
    const { token } = await invite(); // admin create (its own audit) before the audit spy

    // auditRepo.log(entry, db): the connection is the SECOND argument
    const originalLog = auditRepo.log.bind(auditRepo);
    jest.spyOn(auditRepo, 'log').mockImplementation(async (entry, db) => {
      const { rows: [ctx] } = await db.query("SELECT current_user AS role, current_setting('app.current_tenant', true) AS tenant");
      seen.push({ name: `audit:${entry.action}`, ...ctx });
      return originalLog(entry, db);
    });

    expect((await accept(token)).status).toBe(200);
    expect(seen.map(s => s.name)).toEqual([
      'findOrganizationIdByTokenHash', 'lockOrganizationForInvitationAcceptance', 'findByTokenHash',
      'findMembershipForUpdate', 'activateMembershipFromInvitation', 'markAccepted', 'audit:INVITATION_ACCEPT',
    ]);
    expect(seen[0].role).not.toBe('documind_app'); // runtime pool (pre-membership routing lookup)
    expect(seen[0].tenant || '').toBe('');
    for (const s of seen.slice(1)) expect(s).toMatchObject({ role: 'documind_app', tenant: orgA.orgId });
  });

  test('lock order: organization row is locked before the invitation row, invitation before membership', async () => {
    const { token } = await invite();
    const probes = [];
    const probeOrgLock = async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [orgA.orgId]);
        return 'org-free';
      } catch (err) { return err.code; } finally { await c.query('ROLLBACK'); c.release(); }
    };
    const probeInvitationLock = async (hash) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM organization_invitations WHERE token_hash = $1 FOR UPDATE NOWAIT', [hash]);
        return 'invitation-free';
      } catch (err) { return err.code; } finally { await c.query('ROLLBACK'); c.release(); }
    };
    for (const [repo, name, probe] of [
      [invitationRepo, 'findByTokenHash', () => probeOrgLock()],
      [orgRepo, 'findMembershipForUpdate', () => probeInvitationLock(sha256(token))],
    ]) {
      const original = repo[name].bind(repo);
      jest.spyOn(repo, name).mockImplementation(async (...args) => { probes.push(await probe()); return original(...args); });
    }
    expect((await accept(token)).status).toBe(200);
    expect(probes).toEqual(['55P03', '55P03']);
  });

  test('a token is only ever resolved within its own organization', async () => {
    const a = await invite('invitee@documind.test', 'member', orgA);
    jest.spyOn(invitationRepo, 'findOrganizationIdByTokenHash').mockResolvedValueOnce(orgB.orgId); // misrouted
    expect((await accept(a.token)).body).toEqual(INVALID); // RLS + explicit filter: not found in orgB
    expect(await membershipOf(orgB.orgId, invitee.id)).toEqual([]);
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([]);
  });

  test('accepting an invitation of organization A never touches organization B', async () => {
    const a = await invite('invitee@documind.test', 'member', orgA);
    const b = await invite('invitee@documind.test', 'admin', orgB);
    expect((await accept(a.token)).status).toBe(200);
    expect(await membershipOf(orgB.orgId, invitee.id)).toEqual([]);
    expect((await getInvite(b.invitation.id)).status).toBe('pending');
  });

  test('the membership upsert by itself never modifies an ACTIVE membership (second, independent guard)', async () => {
    await pool.query("INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'viewer', 'active')", [orgA.orgId, invitee.id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await orgRepo.activateMembershipFromInvitation(client, { organizationId: orgA.orgId, userId: invitee.id, role: 'admin' });
      expect(result).toBeUndefined();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await membershipOf(orgA.orgId, invitee.id)).toEqual([expect.objectContaining({ role: 'viewer', status: 'active' })]);
  });

  test('the memberships unique constraint name matches the defensive 409 mapping', async () => {
    const { rows } = await pool.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'memberships'::regclass AND contype = 'u'",
    );
    expect(rows.map(r => r.conname)).toContain('memberships_organization_id_user_id_key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Confidentiality and enumeration', () => {
  test('raw tokens are never stored; hashes and raw tokens never appear in responses', async () => {
    const { token, invitation } = await invite();
    const { rows } = await pool.query('SELECT row_to_json(i)::text AS j FROM organization_invitations i');
    expect(rows.map(r => r.j).join('')).not.toContain(token);

    const responses = [await preview(token), await accept(token), await accept(token), await preview(token)];
    for (const res of responses) {
      expect(res.text).not.toContain(token);
      expect(res.text).not.toContain(sha256(token));
      expect(res.text).not.toMatch(/token_hash/);
    }
    expect((await getInvite(invitation.id)).status).toBe('accepted');
  });

  // The all-states indistinguishability check (body + headers + no writes) lives in
  // invitations_indistinguishable.test.js.

  test('raw tokens and hashes never reach logs, including failure paths', async () => {
    const lines = [];
    const previousLevel = logger.getLevel();
    logger.configure({ level: 'debug', write: (line) => lines.push(line) });
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(m =>
      jest.spyOn(console, m).mockImplementation((...args) => lines.push(args.map(String).join(' '))));
    try {
      const { token } = await invite();
      await preview(token);
      jest.spyOn(invitationRepo, 'markAccepted').mockRejectedValueOnce(new Error('boom'));
      expect((await accept(token)).status).toBe(500);
      expect((await accept(token)).status).toBe(200);
      const unknown = newToken();
      await accept(unknown);
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      for (const secret of [token, sha256(token), unknown, sha256(unknown)]) expect(all).not.toContain(secret);
    } finally {
      consoleSpies.forEach(s => s.mockRestore());
      logger.configure({ level: previousLevel, write: (line) => process.stdout.write(`${line}\n`) });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Rate limiting', () => {
  const exhaust = async (key, value) => {
    const redis = getRedisClient();
    if (!redis.isOpen) await redis.connect();
    await redis.set(key, String(value), { EX: 600 });
  };

  test('acceptance is limited per user (429), without consuming the invitation', async () => {
    const { token, invitation } = await invite();
    await exhaust(`ratelimit:invite-accept:${invitee.id}`, 20);
    expect((await accept(token)).status).toBe(429);
    await expectUntouched(invitation.id);
    // Another user is not affected by this user's budget
    const other = await createUser('other@documind.test');
    expect((await accept(newToken(), other.token)).status).toBe(404);
  });

  test('preview is limited per user (429)', async () => {
    const { token } = await invite();
    await exhaust(`ratelimit:invite-preview:${invitee.id}`, 60);
    expect((await preview(token)).status).toBe(429);
  });

  test('limiter keys are per user and never contain the token', async () => {
    const { token } = await invite();
    await preview(token);
    await accept(token);
    const redis = getRedisClient();
    const keys = [...await redis.keys('ratelimit:invite-preview:*'), ...await redis.keys('ratelimit:invite-accept:*')].sort();
    expect(keys).toEqual([`ratelimit:invite-accept:${invitee.id}`, `ratelimit:invite-preview:${invitee.id}`]);
    for (const k of keys) {
      expect(k).not.toContain(token);
      expect(k).not.toContain(sha256(token));
    }
  });

  test('admin invitation APIs and invitee APIs keep independent budgets', async () => {
    await exhaust(`ratelimit:invite-accept:${invitee.id}`, 20);
    expect(await countInvites()).toBe(0);
    await invite(); // admin create still works
    expect(await countInvites()).toBe(1);
  });
});
