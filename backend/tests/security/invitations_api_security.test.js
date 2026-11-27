/**
 * Phase 2 — admin invitation APIs: security, rate limiting and deterministic concurrency.
 *
 * Concurrency tests never rely on timing: a separate connection holds the per-organization
 * lock, the test waits (pg_stat_activity) until the requests are queued on it, mutates state
 * if needed, then releases.
 */

const { pool } = require('../../src/db');
const { withTenantTransaction } = require('../../src/db/transaction');
const logger = require('../../src/observability/logger');
const orgRepo = require('../../src/repositories/org.repository');
const auditRepo = require('../../src/repositories/audit.repository');
const invitationRepo = require('../../src/repositories/invitation.repository');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const h = require('../streaming/stream.helpers');
const {
  sha256, api, invitationsUrl, invitationUrl, seedInvite, getInvite, countInvites,
  clearOrgRateLimits, holdOrgLock, waitForLockWaiters, start,
} = require('./invitation.helpers');

let orgA;
let orgB;
const asA = (role = 'admin') => api(orgA.users[role].token);
const createReq = (email, role = 'member') => asA().post(invitationsUrl(orgA.orgId)).send({ email, role });

beforeEach(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  orgA = await h.createOrgWithUsers('inv-sec-a', ['admin', 'member']);
  orgB = await h.createOrgWithUsers('inv-sec-b', ['admin']);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await h.truncateAll();
  await clearOrgRateLimits();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E. Security', () => {
  test('mutations run as documind_app with the organization as RLS tenant (not the BYPASSRLS runtime role)', async () => {
    const seen = [];
    const record = (name) => {
      const original = invitationRepo[name];
      jest.spyOn(invitationRepo, name).mockImplementation(async (client, args) => {
        const { rows: [ctx] } = await client.query(
          "SELECT current_user AS role, current_setting('app.current_tenant', true) AS tenant, " +
          "(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass",
        );
        seen.push({ name, ...ctx });
        return original(client, args);
      });
    };
    ['create', 'listByOrganization', 'revoke', 'rotateToken'].forEach(record);

    // The audit entry must be written on the same transaction client (same transaction id).
    const originalLog = auditRepo.log.bind(auditRepo);
    jest.spyOn(auditRepo, 'log').mockImplementation(async (entry, db) => {
      const { rows: [ctx] } = await db.query(
        "SELECT current_user AS role, current_setting('app.current_tenant', true) AS tenant, txid_current_if_assigned() IS NOT NULL AS in_write_tx",
      );
      seen.push({ name: `audit:${entry.action}`, ...ctx });
      return originalLog(entry, db);
    });

    const { body } = await createReq('ctx@documind.test');
    const id = body.data.invitation.id;
    await asA().get(invitationsUrl(orgA.orgId));
    await asA().post(`${invitationUrl(orgA.orgId, id)}/resend`);
    await asA().delete(invitationUrl(orgA.orgId, id));

    expect(seen.map(s => s.name)).toEqual([
      'create', 'audit:INVITATION_CREATE', 'listByOrganization',
      'rotateToken', 'audit:INVITATION_RESEND', 'revoke', 'audit:INVITATION_REVOKE',
    ]);
    for (const s of seen) expect(s).toMatchObject({ role: 'documind_app', tenant: orgA.orgId });
    for (const s of seen.filter(x => !x.name.startsWith('audit:'))) expect(s.bypass).toBe(false);
    // in_write_tx: the invitation row was already written in this transaction when the audit ran
    for (const s of seen.filter(x => x.name.startsWith('audit:'))) expect(s.in_write_tx).toBe(true);
  });

  test("RLS: inside organization B's tenant context, organization A's invitations are invisible and unmodifiable", async () => {
    const invA = await seedInvite({ organization_id: orgA.orgId });
    await withTenantTransaction(orgB.orgId, async (client) => {
      const { rows } = await client.query('SELECT id FROM organization_invitations WHERE id = $1', [invA.id]);
      expect(rows).toHaveLength(0);
      const { rowCount } = await client.query("UPDATE organization_invitations SET status = 'revoked', revoked_at = now() WHERE id = $1", [invA.id]);
      expect(rowCount).toBe(0);
    });
    expect((await getInvite(invA.id)).status).toBe('pending');
  });

  test('the admin check is repeated inside the transaction: a stale pre-check cannot authorize a write', async () => {
    // requireOrgAdmin (outside the transaction) is fooled into "admin"; the in-transaction check must still refuse.
    jest.spyOn(orgRepo, 'validateMembership').mockResolvedValue({ role: 'admin' });
    const inv = await seedInvite({ organization_id: orgA.orgId });

    const member = asA('member');
    expect((await member.post(invitationsUrl(orgA.orgId)).send({ email: 'x@documind.test', role: 'admin' })).status).toBe(403);
    expect((await member.delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(403);
    expect((await member.post(`${invitationUrl(orgA.orgId, inv.id)}/resend`)).status).toBe(403);

    expect(await countInvites()).toBe(1);
    const row = await getInvite(inv.id);
    expect(row.status).toBe('pending');
    expect(row.token_hash).toBe(inv.token_hash);
  });

  test('lock order: the organization row is already locked when the invitation row is locked', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    const original = invitationRepo.findForUpdate;
    const probes = [];
    jest.spyOn(invitationRepo, 'findForUpdate').mockImplementation(async (client, args) => {
      // From another connection, the organization lock must be unavailable right now.
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT 1 FROM organizations WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [orgA.orgId]);
        probes.push('org-unlocked');
      } catch (err) {
        probes.push(err.code);
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }
      return original(client, args);
    });

    expect((await asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`)).status).toBe(200);
    expect((await asA().delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(200);
    expect(probes).toEqual(['55P03', '55P03']);
  });

  test('raw tokens and token hashes never reach logs, even on failures', async () => {
    const lines = [];
    const previousLevel = logger.getLevel();
    logger.configure({ level: 'debug', write: (line) => lines.push(line) });
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(m =>
      jest.spyOn(console, m).mockImplementation((...args) => lines.push(args.map(String).join(' '))));
    try {
      const created = await createReq('logs@documind.test');
      const { invitation, token } = created.body.data;
      const resent = await asA().post(`${invitationUrl(orgA.orgId, invitation.id)}/resend`);
      const secrets = [token, resent.body.data.token, sha256(token), sha256(resent.body.data.token)];

      // A failing resend (500 path is logged with error details)
      jest.spyOn(invitationRepo, 'rotateToken').mockRejectedValueOnce(new Error('boom'));
      expect((await asA().post(`${invitationUrl(orgA.orgId, invitation.id)}/resend`)).status).toBe(500);

      expect(lines.length).toBeGreaterThan(0); // the capture is live
      const all = lines.join('\n');
      for (const secret of secrets) expect(all).not.toContain(secret);
    } finally {
      consoleSpies.forEach(s => s.mockRestore());
      logger.configure({ level: previousLevel, write: (line) => process.stdout.write(`${line}\n`) });
    }
  });

  test('database errors are not leaked to clients', async () => {
    jest.spyOn(invitationRepo, 'create').mockRejectedValueOnce(
      Object.assign(new Error('relation "organization_invitations" violates something secret'), { code: 'XX000' }));
    const res = await createReq('leak@documind.test');
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/organization_invitations|secret|stack|\bat \S+:\d+/);
  });

  test('a unique-violation on the pending-email index maps to 409 (defensive path)', async () => {
    jest.spyOn(invitationRepo, 'findPendingByEmail').mockResolvedValueOnce(undefined);
    await seedInvite({ organization_id: orgA.orgId, email: 'race@documind.test' });
    const res = await createReq('race@documind.test');
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A pending invitation already exists for this email address.');
  });

  test('the invitation email is never checked against registered accounts (no account enumeration)', async () => {
    const registered = await createReq('inv-sec-a_member@documind.test'); // an existing user's email
    const unknown = await createReq('nobody-registered@documind.test');
    expect([registered.status, unknown.status]).toEqual([201, 201]);
    expect(Object.keys(registered.body.data.invitation).sort()).toEqual(Object.keys(unknown.body.data.invitation).sort());
  });

  test("organization A's admin is refused on every organization B invitation endpoint", async () => {
    const invB = await seedInvite({ organization_id: orgB.orgId });
    const responses = await Promise.all([
      asA().post(invitationsUrl(orgB.orgId)).send({ email: 'x@documind.test', role: 'admin' }),
      asA().get(invitationsUrl(orgB.orgId)),
      asA().delete(invitationUrl(orgB.orgId, invB.id)),
      asA().post(`${invitationUrl(orgB.orgId, invB.id)}/resend`),
    ]);
    expect(responses.map(r => r.status)).toEqual([403, 403, 403, 403]);
    const row = await getInvite(invB.id);
    expect(row.status).toBe('pending');
    expect(row.token_hash).toBe(invB.token_hash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Rate limiting', () => {
  const inviteKey = (userId, orgId) => `ratelimit:org-invite:${userId}:${orgId}`;
  const exhaust = async (key, value) => {
    const redis = getRedisClient();
    if (!redis.isOpen) await redis.connect();
    await redis.set(key, String(value), { EX: 600 });
  };

  test('create and resend share a per-admin, per-organization send budget (429 when exhausted)', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    await exhaust(inviteKey(orgA.users.admin.id, orgA.orgId), 30);
    expect((await createReq('limited@documind.test')).status).toBe(429);
    expect((await asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`)).status).toBe(429);
    expect(await countInvites()).toBe(1);
    expect((await getInvite(inv.id)).token_hash).toBe(inv.token_hash);

    // Listing and revoking are not governed by the send budget
    expect((await asA().get(invitationsUrl(orgA.orgId))).status).toBe(200);
    expect((await asA().delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(200);
  });

  test('the send budget is scoped per organization and per user', async () => {
    await exhaust(inviteKey(orgA.users.admin.id, orgA.orgId), 30);
    // Same admin user, other organization: make orgA's admin also an admin of orgB
    await pool.query(
      "INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')",
      [orgB.orgId, orgA.users.admin.id],
    );
    expect((await asA().post(invitationsUrl(orgB.orgId)).send({ email: 'other-org@documind.test', role: 'member' })).status).toBe(201);
    // A different admin user is unaffected
    expect((await api(orgB.users.admin.token).post(invitationsUrl(orgB.orgId)).send({ email: 'b@documind.test', role: 'member' })).status).toBe(201);
  });

  test('lowercase, uppercase and mixed-case organization IDs share one hourly send budget (F1)', async () => {
    const lower = orgA.orgId.toLowerCase();
    const upper = orgA.orgId.toUpperCase();
    let flip = false;
    const mixed = lower.replace(/[a-f]/g, (c) => { flip = !flip; return flip ? c.toUpperCase() : c; });
    expect(new Set([lower, upper, mixed]).size).toBe(3);

    const key = inviteKey(orgA.users.admin.id, lower);
    await exhaust(key, 27); // 3 sends left in this window
    const send = (id, email) => asA().post(invitationsUrl(id)).send({ email, role: 'member' });

    expect((await send(lower, 'case-1@documind.test')).status).toBe(201);
    expect((await send(upper, 'case-2@documind.test')).status).toBe(201);
    expect((await send(mixed, 'case-3@documind.test')).status).toBe(201);
    // Budget exhausted for every spelling of the same organization
    expect((await send(upper, 'case-4@documind.test')).status).toBe(429);
    expect((await send(mixed, 'case-5@documind.test')).status).toBe(429);
    expect((await send(lower, 'case-6@documind.test')).status).toBe(429);
    const inv = await seedInvite({ organization_id: orgA.orgId });
    expect((await asA().post(`${invitationUrl(upper, inv.id)}/resend`)).status).toBe(429);

    expect(await countInvites("email LIKE 'case-%'")).toBe(3);
    // Exactly one counter exists for this admin, under the lowercase organization ID
    const redis = getRedisClient();
    expect(await redis.keys(`ratelimit:org-invite:${orgA.users.admin.id}:*`)).toEqual([key]);
    expect(Number(await redis.get(key))).toBe(34);
  });

  test('revoke is governed by the organization write budget', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    await exhaust(`ratelimit:org-write:${orgA.users.admin.id}`, 60);
    expect((await asA().delete(invitationUrl(orgA.orgId, inv.id))).status).toBe(429);
    expect((await getInvite(inv.id)).status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F. Concurrency (deterministic, lock-barrier based)', () => {
  let lock;
  afterEach(async () => { if (lock) await lock.release(); lock = null; });

  test('two concurrent creates for the same email: exactly one succeeds, the other gets 409', async () => {
    lock = await holdOrgLock(orgA.orgId);
    const a = start(createReq('same@documind.test', 'member'));
    const b = start(createReq('SAME@documind.test', 'viewer'));
    await waitForLockWaiters(2);
    await lock.release();

    const statuses = (await Promise.all([a, b])).map(r => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await countInvites("email = 'same@documind.test'")).toBe(1);
  });

  test('concurrent resend and revoke serialize: the invitation ends revoked and never pending again', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    lock = await holdOrgLock(orgA.orgId);
    const resend = start(asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`));
    const revoke = start(asA().delete(invitationUrl(orgA.orgId, inv.id)));
    await waitForLockWaiters(2);
    await lock.release();

    const [resendRes, revokeRes] = await Promise.all([resend, revoke]);
    expect(revokeRes.status).toBe(200);
    // Either resend went first (200, then revoked) or after (409 revoked) — never interleaved.
    expect([200, 409]).toContain(resendRes.status);
    if (resendRes.status === 409) expect(resendRes.body.message).toBe('This invitation has been revoked.');

    const row = await getInvite(inv.id);
    expect(row.status).toBe('revoked');
    expect(row.revoked_at).not.toBeNull();

    // A later resend cannot revive it
    expect((await asA().post(`${invitationUrl(orgA.orgId, inv.id)}/resend`)).status).toBe(409);
    expect((await getInvite(inv.id)).status).toBe('revoked');
  });

  test('admin demoted while the create is queued on the lock: 403, nothing created', async () => {
    lock = await holdOrgLock(orgA.orgId);
    const req = start(createReq('demoted@documind.test'));
    await waitForLockWaiters(1); // requireOrgAdmin already passed
    await lock.client.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
      [orgA.orgId, orgA.users.admin.id]);
    await lock.release();

    expect((await req).status).toBe(403);
    expect(await countInvites()).toBe(0);
  });

  test('organization deactivated while the create is queued on the lock: 403, nothing created', async () => {
    lock = await holdOrgLock(orgA.orgId);
    const req = start(createReq('suspended@documind.test'));
    await waitForLockWaiters(1);
    await lock.client.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [orgA.orgId]);
    await lock.release();

    expect((await req).status).toBe(403);
    expect(await countInvites()).toBe(0);
  });

  test('admin demoted while a revoke is queued: 403 and the invitation stays pending', async () => {
    const inv = await seedInvite({ organization_id: orgA.orgId });
    lock = await holdOrgLock(orgA.orgId);
    const req = start(asA().delete(invitationUrl(orgA.orgId, inv.id)));
    await waitForLockWaiters(1);
    await lock.client.query("UPDATE memberships SET status = 'removed' WHERE organization_id = $1 AND user_id = $2",
      [orgA.orgId, orgA.users.admin.id]);
    await lock.release();

    expect((await req).status).toBe(403);
    expect((await getInvite(inv.id)).status).toBe('pending');
  });

  test('a held organization lock beyond lock_timeout yields a retryable 409, not a hang', async () => {
    const original = orgRepo.memberLockTimeoutMs;
    orgRepo.memberLockTimeoutMs = 300;
    lock = await holdOrgLock(orgA.orgId);
    const safety = setTimeout(() => lock && lock.release(), 5000);
    try {
      const res = await createReq('timeout@documind.test');
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Another change to this organization is in progress. Please retry.');
      expect(await countInvites()).toBe(0);
    } finally {
      clearTimeout(safety);
      orgRepo.memberLockTimeoutMs = original;
    }
  });
});
