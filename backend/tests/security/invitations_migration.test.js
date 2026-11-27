/**
 * Migration 010 — organization_invitations schema tests
 *
 * Raw SQL only (no application service layer), like google_auth_migration.test.js:
 *   1. table structure and defaults
 *   2. every CHECK constraint (email, role, status, token hash, expiry, accepted/revoked consistency)
 *   3. UNIQUE token_hash and the partial "one pending invitation per org/email" index
 *   4. FK ON DELETE CASCADE (organization) and ON DELETE SET NULL (users)
 *   5. RLS enabled + forced + tenant_isolation policy
 *   6. exact privileges for documind_app / documind_runtime / PUBLIC
 *   7. real tenant isolation under SET LOCAL ROLE documind_app
 *   8. test cleanup (truncateAll) removes invitation rows
 */

'use strict';

const crypto = require('crypto');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const h = require('../streaming/stream.helpers');

const TABLE = 'organization_invitations';
const HOUR = 60 * 60 * 1000;

// ─── helpers ──────────────────────────────────────────────────────────────────

const tokenHash = () => crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
const inHours = (n) => new Date(Date.now() + n * HOUR);

/** Insert an invitation (columns come from this file only, never from input). */
async function insertInvite(db, fields) {
  const row = {
    email: 'invitee@documind.test',
    role: 'member',
    token_hash: tokenHash(),
    expires_at: inHours(72),
    ...fields,
  };
  const cols = Object.keys(row);
  const { rows } = await db.query(
    `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row),
  );
  return rows[0];
}

/** Assert a PostgreSQL error code (and optionally the violated constraint). */
async function expectPgError(promise, code, constraint) {
  let error;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error).toBeDefined();
  expect(error.code).toBe(code);
  if (constraint) expect(error.constraint).toBe(constraint);
}

/**
 * Run `fn` exactly as the application's tenant transactions do (src/db/transaction.js):
 * SET LOCAL ROLE documind_app + transaction-local tenant setting. Always rolled back.
 * tenantId === undefined → no tenant context at all.
 */
async function asTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE documind_app');
    if (tenantId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', [env.PG_TENANT_SETTING, tenantId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function countInvites(where = 'TRUE', params = []) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE ${where}`, params);
  return rows[0].n;
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

let orgA;
let orgB;

beforeEach(async () => {
  await h.truncateAll();
  orgA = await h.createOrgWithUsers('inv-a', ['admin', 'member']);
  orgB = await h.createOrgWithUsers('inv-b', ['admin']);
});

// Ending the pool is safe: Jest gives every test file its own module registry (also with
// --runInBand), so this file's `require('../../src/db')` built a pool that no other suite
// uses. 12 other suites end their pool the same way.
afterAll(async () => {
  await h.truncateAll();
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('1. Table structure', () => {
  test('all expected columns exist with the expected types, nullability and defaults', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, character_maximum_length AS len, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    const cols = Object.fromEntries(rows.map(r => [r.column_name, r]));
    const expected = {
      id: ['uuid', null, 'NO'],
      organization_id: ['uuid', null, 'NO'],
      email: ['character varying', 255, 'NO'],
      role: ['character varying', 20, 'NO'],
      token_hash: ['character', 64, 'NO'],
      status: ['character varying', 20, 'NO'],
      invited_by: ['uuid', null, 'YES'],
      accepted_by: ['uuid', null, 'YES'],
      revoked_by: ['uuid', null, 'YES'],
      expires_at: ['timestamp with time zone', null, 'NO'],
      accepted_at: ['timestamp with time zone', null, 'YES'],
      revoked_at: ['timestamp with time zone', null, 'YES'],
      created_at: ['timestamp with time zone', null, 'NO'],
      updated_at: ['timestamp with time zone', null, 'NO'],
    };
    expect(Object.keys(cols).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [type, len, nullable]] of Object.entries(expected)) {
      expect([name, cols[name].data_type, cols[name].len, cols[name].is_nullable]).toEqual([name, type, len, nullable]);
    }
    expect(cols.id.column_default).toContain('gen_random_uuid()');
    expect(cols.status.column_default).toContain("'pending'");
    expect(cols.created_at.column_default).toContain('now()');
    expect(cols.updated_at.column_default).toContain('now()');
  });

  test('a minimal valid invitation gets the defaults (pending, id, timestamps)', async () => {
    const inv = await insertInvite(pool, { organization_id: orgA.orgId, invited_by: orgA.users.admin.id });
    expect(inv.status).toBe('pending');
    expect(inv.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inv.created_at).toBeInstanceOf(Date);
    expect(inv.updated_at).toBeInstanceOf(Date);
    expect(inv.accepted_at).toBeNull();
    expect(inv.revoked_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. CHECK constraints', () => {
  const base = () => ({ organization_id: orgA.orgId });

  describe('email is stored normalized (lowercase, trimmed, non-empty)', () => {
    test.each([
      ['uppercase', 'Alice@Example.com'],
      ['leading space', ' alice@example.com'],
      ['trailing space', 'alice@example.com '],
      ['empty', ''],
      ['whitespace only', '   '],
    ])('%s email is rejected', async (_label, email) => {
      await expectPgError(insertInvite(pool, { ...base(), email }), '23514', 'chk_org_invitations_email');
    });

    test('a normalized email is accepted', async () => {
      const inv = await insertInvite(pool, { ...base(), email: 'alice@example.com' });
      expect(inv.email).toBe('alice@example.com');
    });
  });

  describe('role', () => {
    test.each(['owner', 'superadmin', 'Admin', ''])('role %p is rejected', async (role) => {
      await expectPgError(insertInvite(pool, { ...base(), role }), '23514', 'chk_org_invitations_role');
    });

    test.each(['admin', 'member', 'viewer'])('role %p is accepted', async (role) => {
      const inv = await insertInvite(pool, { ...base(), role, email: `${role}@documind.test` });
      expect(inv.role).toBe(role);
    });
  });

  describe('status', () => {
    test.each(['active', 'invited', 'PENDING', ''])('status %p is rejected', async (status) => {
      await expectPgError(insertInvite(pool, { ...base(), status }), '23514', 'chk_org_invitations_status');
    });

    test('pending and expired need no lifecycle timestamps', async () => {
      await insertInvite(pool, { ...base(), status: 'pending', email: 'p@documind.test' });
      await insertInvite(pool, { ...base(), status: 'expired', email: 'e@documind.test' });
      expect(await countInvites()).toBe(2);
    });
  });

  describe('token_hash is 64 lowercase hex characters', () => {
    test.each([
      ['uppercase hex', 'A'.repeat(64)],
      ['non-hex characters', 'g'.repeat(64)],
      ['too short (63)', 'a'.repeat(63)],
      ['empty', ''],
      ['raw token-like value', `${'a'.repeat(32)}-${'b'.repeat(31)}`],
    ])('%s is rejected', async (_label, value) => {
      await expectPgError(insertInvite(pool, { ...base(), token_hash: value }), '23514', 'chk_org_invitations_token_hash');
    });

    test('longer than 64 characters is rejected by the column type', async () => {
      await expectPgError(insertInvite(pool, { ...base(), token_hash: 'a'.repeat(65) }), '22001');
    });

    test('a real SHA-256 hex digest is accepted and stored exactly', async () => {
      const hash = tokenHash();
      const inv = await insertInvite(pool, { ...base(), token_hash: hash });
      expect(inv.token_hash).toBe(hash);
    });

    test('the stored CHAR(64) value is exactly the 64-character digest: no padding, found by exact lookup', async () => {
      const hash = tokenHash();
      const inv = await insertInvite(pool, { ...base(), token_hash: hash });
      const { rows } = await pool.query(
        `SELECT token_hash, length(token_hash) AS len, octet_length(token_hash) AS bytes,
                token_hash::text AS as_text, length(token_hash::text) AS text_len
         FROM ${TABLE} WHERE id = $1`,
        [inv.id],
      );
      expect(rows[0]).toEqual({ token_hash: hash, len: 64, bytes: 64, as_text: hash, text_len: 64 });

      // The lookup the acceptance flow will use: a text parameter against the CHAR(64) column
      const byHash = await pool.query(`SELECT id FROM ${TABLE} WHERE token_hash = $1`, [hash]);
      expect(byHash.rows).toEqual([{ id: inv.id }]);
    });

    test('why 63 characters are rejected: CHAR(64) pads them, and the hex CHECK fails either way', async () => {
      // Pure expression evaluation (no table access): documents the type semantics the CHECK relies on
      const short = 'a'.repeat(63);
      const { rows } = await pool.query(
        `SELECT octet_length($1::char(64)) AS padded_bytes,
                length($1::char(64))       AS significant_len,
                $1::char(64) ~ '^[0-9a-f]{64}$' AS short_matches,
                $2::char(64) ~ '^[0-9a-f]{64}$' AS full_matches`,
        [short, 'a'.repeat(64)],
      );
      expect(rows[0]).toEqual({ padded_bytes: 64, significant_len: 63, short_matches: false, full_matches: true });
    });
  });

  describe('expiry must be after creation', () => {
    test('expires_at in the past is rejected', async () => {
      await expectPgError(insertInvite(pool, { ...base(), expires_at: inHours(-1) }), '23514', 'chk_org_invitations_expiry');
    });

    test('expires_at equal to created_at is rejected', async () => {
      const t = new Date();
      await expectPgError(insertInvite(pool, { ...base(), created_at: t, expires_at: t }), '23514', 'chk_org_invitations_expiry');
    });
  });

  describe('accepted/revoked consistency', () => {
    const now = () => new Date();

    test.each([
      ['accepted without accepted_at', { status: 'accepted' }, 'chk_org_invitations_accepted'],
      ['pending with accepted_at', { status: 'pending', accepted_at: now() }, 'chk_org_invitations_accepted'],
      ['revoked with accepted_at', { status: 'revoked', revoked_at: now(), accepted_at: now() }, 'chk_org_invitations_accepted'],
      ['revoked without revoked_at', { status: 'revoked' }, 'chk_org_invitations_revoked'],
      ['pending with revoked_at', { status: 'pending', revoked_at: now() }, 'chk_org_invitations_revoked'],
      ['accepted with revoked_at', { status: 'accepted', accepted_at: now(), revoked_at: now() }, 'chk_org_invitations_revoked'],
      ['expired with accepted_at', { status: 'expired', accepted_at: now() }, 'chk_org_invitations_accepted'],
    ])('%s is rejected', async (_label, fields, constraint) => {
      await expectPgError(insertInvite(pool, { ...base(), ...fields }), '23514', constraint);
    });

    test('accepted with accepted_at, and revoked with revoked_at, are accepted', async () => {
      await insertInvite(pool, { ...base(), email: 'a@documind.test', status: 'accepted', accepted_at: new Date(), accepted_by: orgA.users.member.id });
      await insertInvite(pool, { ...base(), email: 'r@documind.test', status: 'revoked', revoked_at: new Date(), revoked_by: orgA.users.admin.id });
      expect(await countInvites()).toBe(2);
    });

    test('a pending invitation can transition to accepted only together with accepted_at', async () => {
      const inv = await insertInvite(pool, base());
      await expectPgError(pool.query(`UPDATE ${TABLE} SET status = 'accepted' WHERE id = $1`, [inv.id]), '23514', 'chk_org_invitations_accepted');
      const { rows } = await pool.query(
        `UPDATE ${TABLE} SET status = 'accepted', accepted_at = now(), accepted_by = $2 WHERE id = $1 RETURNING status`,
        [inv.id, orgA.users.member.id],
      );
      expect(rows[0].status).toBe('accepted');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3. Uniqueness', () => {
  test('the same token_hash cannot be stored twice, even across organizations', async () => {
    const hash = tokenHash();
    await insertInvite(pool, { organization_id: orgA.orgId, token_hash: hash });
    await expectPgError(
      insertInvite(pool, { organization_id: orgB.orgId, token_hash: hash, email: 'other@documind.test' }),
      '23505', 'uq_org_invitations_token_hash',
    );
  });

  test('two pending invitations for the same email in the same organization are rejected', async () => {
    await insertInvite(pool, { organization_id: orgA.orgId, email: 'dup@documind.test' });
    await expectPgError(
      insertInvite(pool, { organization_id: orgA.orgId, email: 'dup@documind.test', role: 'viewer' }),
      '23505', 'uidx_org_invitations_pending_email',
    );
  });

  test('history rows (accepted, revoked, expired) do not block a new pending invitation', async () => {
    const email = 'again@documind.test';
    await insertInvite(pool, { organization_id: orgA.orgId, email, status: 'accepted', accepted_at: new Date() });
    await insertInvite(pool, { organization_id: orgA.orgId, email, status: 'revoked', revoked_at: new Date() });
    await insertInvite(pool, { organization_id: orgA.orgId, email, status: 'expired' });
    await insertInvite(pool, { organization_id: orgA.orgId, email });
    expect(await countInvites('email = $1', [email])).toBe(4);
  });

  test('the same email may have a pending invitation in different organizations', async () => {
    await insertInvite(pool, { organization_id: orgA.orgId, email: 'multi@documind.test' });
    await insertInvite(pool, { organization_id: orgB.orgId, email: 'multi@documind.test' });
    expect(await countInvites("email = 'multi@documind.test' AND status = 'pending'")).toBe(2);
  });

  test('marking the pending invitation expired frees the slot for a new one', async () => {
    const first = await insertInvite(pool, { organization_id: orgA.orgId, email: 'reinvite@documind.test' });
    await pool.query(`UPDATE ${TABLE} SET status = 'expired' WHERE id = $1`, [first.id]);
    const second = await insertInvite(pool, { organization_id: orgA.orgId, email: 'reinvite@documind.test' });
    expect(second.status).toBe('pending');
  });

  test('the partial unique index and the listing index are defined as designed', async () => {
    const { rows } = await pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
      [TABLE],
    );
    const defs = Object.fromEntries(rows.map(r => [r.indexname, r.indexdef]));
    expect(defs.uidx_org_invitations_pending_email).toMatch(/CREATE UNIQUE INDEX .* \(organization_id, email\) WHERE \(\(status\)::text = 'pending'::text\)/);
    expect(defs.idx_org_invitations_org_status).toMatch(/CREATE INDEX .* \(organization_id, status, created_at\)$/);
    expect(defs.uq_org_invitations_token_hash).toMatch(/CREATE UNIQUE INDEX .* \(token_hash\)$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. Foreign keys', () => {
  test('FK delete rules: organization CASCADE, user references SET NULL', async () => {
    const { rows } = await pool.query(
      `SELECT kcu.column_name, ccu.table_name AS ref_table, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
      [TABLE],
    );
    const fks = Object.fromEntries(rows.map(r => [r.column_name, `${r.ref_table}:${r.delete_rule}`]));
    expect(fks).toEqual({
      organization_id: 'organizations:CASCADE',
      invited_by: 'users:SET NULL',
      accepted_by: 'users:SET NULL',
      revoked_by: 'users:SET NULL',
    });
  });

  test('deleting an organization deletes its invitations only', async () => {
    await insertInvite(pool, { organization_id: orgA.orgId, email: 'a1@documind.test' });
    await insertInvite(pool, { organization_id: orgA.orgId, email: 'a2@documind.test' });
    await insertInvite(pool, { organization_id: orgB.orgId, email: 'b1@documind.test' });

    await pool.query('DELETE FROM organizations WHERE id = $1', [orgA.orgId]);
    expect(await countInvites('organization_id = $1', [orgA.orgId])).toBe(0);
    expect(await countInvites('organization_id = $1', [orgB.orgId])).toBe(1);
  });

  test('deleting a user clears invited_by / accepted_by / revoked_by but keeps the invitation and its status', async () => {
    const admin = orgA.users.admin.id;
    const member = orgA.users.member.id;
    const accepted = await insertInvite(pool, {
      organization_id: orgA.orgId, email: 'acc@documind.test', invited_by: admin,
      status: 'accepted', accepted_at: new Date(), accepted_by: member,
    });
    const revoked = await insertInvite(pool, {
      organization_id: orgA.orgId, email: 'rev@documind.test', invited_by: member,
      status: 'revoked', revoked_at: new Date(), revoked_by: member,
    });

    await pool.query('DELETE FROM users WHERE id = $1', [member]);

    const { rows } = await pool.query(
      `SELECT id, status, invited_by, accepted_by, revoked_by, accepted_at, revoked_at FROM ${TABLE} WHERE id = ANY($1::uuid[])`,
      [[accepted.id, revoked.id]],
    );
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(byId[accepted.id]).toMatchObject({ status: 'accepted', invited_by: admin, accepted_by: null });
    expect(byId[accepted.id].accepted_at).not.toBeNull();
    expect(byId[revoked.id]).toMatchObject({ status: 'revoked', invited_by: null, revoked_by: null });
    expect(byId[revoked.id].revoked_at).not.toBeNull();
  });

  test('an invitation cannot reference a non-existent organization or user', async () => {
    await expectPgError(insertInvite(pool, { organization_id: '00000000-0000-4000-8000-000000000000' }), '23503');
    await expectPgError(insertInvite(pool, { organization_id: orgA.orgId, invited_by: '00000000-0000-4000-8000-000000000000' }), '23503');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5. Row-Level Security definition', () => {
  test('RLS is enabled and forced', async () => {
    const { rows } = await pool.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace",
      [TABLE],
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  test('exactly one tenant_isolation policy, for all commands, keyed on the tenant setting', async () => {
    const { rows } = await pool.query(
      "SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1",
      [TABLE],
    );
    // Migration 012 adds exactly one more policy: SELECT-only, for the NOLOGIN routing-function
    // owner alone (it can read just token_hash and organization_id). Nothing else is allowed.
    expect(rows).toHaveLength(2);
    const router = rows.find(r => r.policyname === 'token_router_lookup');
    expect(router).toEqual({
      policyname: 'token_router_lookup', permissive: 'PERMISSIVE', roles: ['documind_token_router'],
      cmd: 'SELECT', qual: 'true', with_check: null,
    });
    const p = rows.find(r => r.policyname !== 'token_router_lookup');
    expect(p.policyname).toBe('tenant_isolation_organization_invitations');
    expect(p.permissive).toBe('PERMISSIVE');
    expect(p.cmd).toBe('ALL');
    expect(p.roles).toEqual(['public']);
    // The app sets env.PG_TENANT_SETTING; the policy must read the same setting
    for (const expr of [p.qual, p.with_check]) {
      expect(expr).toContain(`current_setting('${env.PG_TENANT_SETTING}'::text, true)`);
      expect(expr).toContain('organization_id =');
    }
  });

  test('the policy uses the same expression as the existing tenant tables', async () => {
    const { rows } = await pool.query(
      "SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename IN ($1, 'documents') AND policyname LIKE 'tenant_isolation%'",
      [TABLE],
    );
    const byTable = Object.fromEntries(rows.map(r => [r.tablename, r]));
    expect(byTable[TABLE].qual).toBe(byTable.documents.qual);
    expect(byTable[TABLE].with_check).toBe(byTable.documents.with_check);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('6. Privileges', () => {
  async function directGrants(grantee) {
    const { rows } = await pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2 ORDER BY privilege_type`,
      [TABLE, grantee],
    );
    return rows.map(r => r.privilege_type);
  }

  async function hasPrivilege(role, privilege) {
    const { rows } = await pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, TABLE, privilege]);
    return rows[0].ok;
  }

  test('documind_app holds exactly SELECT, INSERT, UPDATE, DELETE', async () => {
    expect(await directGrants('documind_app')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  test('documind_runtime holds exactly SELECT and UPDATE directly (token lookup and acceptance)', async () => {
    expect(await directGrants('documind_runtime')).toEqual(['SELECT', 'UPDATE']);
    expect(await hasPrivilege('documind_runtime', 'SELECT')).toBe(true);
    expect(await hasPrivilege('documind_runtime', 'UPDATE')).toBe(true);
  });

  test('documind_runtime is a member of documind_app WITH INHERIT (source of its inherited privileges)', async () => {
    const { rows } = await pool.query(
      `SELECT m.inherit_option FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
       WHERE r.rolname = 'documind_runtime' AND g.rolname = 'documind_app'`,
    );
    expect(rows).toEqual([{ inherit_option: true }]);
  });

  test('documind_runtime effectively has SELECT, INSERT, UPDATE, DELETE; INSERT and DELETE only via inherited documind_app', async () => {
    // Known and documented in migration 010: the direct grant is SELECT/UPDATE only, but
    // membership in documind_app (INHERIT) makes INSERT and DELETE effective as well.
    // Narrowing this would require a role-membership change, which is out of scope.
    const direct = await directGrants('documind_runtime');
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect([privilege, await hasPrivilege('documind_runtime', privilege)]).toEqual([privilege, true]);
      expect([privilege, await hasPrivilege('documind_app', privilege)]).toEqual([privilege, true]);
    }
    expect(direct).not.toContain('INSERT');
    expect(direct).not.toContain('DELETE');
  });

  test('PUBLIC has no privileges', async () => {
    expect(await directGrants('PUBLIC')).toEqual([]);
  });

  test.each(['documind_app', 'documind_runtime'])('%s has no TRUNCATE, TRIGGER or REFERENCES (direct or inherited)', async (role) => {
    for (const privilege of ['TRUNCATE', 'TRIGGER', 'REFERENCES']) {
      expect([privilege, await hasPrivilege(role, privilege)]).toEqual([privilege, false]);
    }
  });

  test('documind_app cannot TRUNCATE the table inside a tenant transaction', async () => {
    await asTenant(orgA.orgId, async (client) => {
      await expectPgError(client.query(`TRUNCATE ${TABLE}`), '42501');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('7. Tenant isolation under SET LOCAL ROLE documind_app', () => {
  let inviteA;
  let inviteB;

  beforeEach(async () => {
    // Seeded as the schema owner (outside RLS), like the other suites' fixtures
    inviteA = await insertInvite(pool, { organization_id: orgA.orgId, email: 'a@documind.test', invited_by: orgA.users.admin.id });
    inviteB = await insertInvite(pool, { organization_id: orgB.orgId, email: 'b@documind.test', invited_by: orgB.users.admin.id });
  });

  test('sanity: the tenant transaction really runs as documind_app with the tenant set', async () => {
    await asTenant(orgA.orgId, async (client) => {
      const { rows } = await client.query('SELECT current_user AS u, current_setting($1, true) AS t', [env.PG_TENANT_SETTING]);
      expect(rows[0]).toEqual({ u: 'documind_app', t: orgA.orgId });
    });
  });

  test('organization A sees only its own invitations', async () => {
    await asTenant(orgA.orgId, async (client) => {
      const { rows } = await client.query(`SELECT id, organization_id FROM ${TABLE}`);
      expect(rows).toEqual([{ id: inviteA.id, organization_id: orgA.orgId }]);
    });
  });

  test("organization A cannot read organization B's invitation, even by id or token hash", async () => {
    await asTenant(orgA.orgId, async (client) => {
      const byId = await client.query(`SELECT 1 FROM ${TABLE} WHERE id = $1`, [inviteB.id]);
      const byHash = await client.query(`SELECT 1 FROM ${TABLE} WHERE token_hash = $1`, [inviteB.token_hash]);
      expect(byId.rowCount).toBe(0);
      expect(byHash.rowCount).toBe(0);
    });
  });

  test('organization A cannot insert an invitation for organization B', async () => {
    await asTenant(orgA.orgId, async (client) => {
      await expectPgError(insertInvite(client, { organization_id: orgB.orgId, email: 'x@documind.test' }), '42501');
    });
    expect(await countInvites('organization_id = $1', [orgB.orgId])).toBe(1);
  });

  test("organization A cannot update or delete organization B's invitation", async () => {
    await asTenant(orgA.orgId, async (client) => {
      const upd = await client.query(
        `UPDATE ${TABLE} SET status = 'revoked', revoked_at = now() WHERE id = $1`, [inviteB.id],
      );
      const del = await client.query(`DELETE FROM ${TABLE} WHERE id = $1`, [inviteB.id]);
      expect(upd.rowCount).toBe(0);
      expect(del.rowCount).toBe(0);
    });
    const { rows } = await pool.query(`SELECT status FROM ${TABLE} WHERE id = $1`, [inviteB.id]);
    expect(rows[0].status).toBe('pending');
  });

  test('organization A cannot move its own invitation into organization B (WITH CHECK)', async () => {
    await asTenant(orgA.orgId, async (client) => {
      await expectPgError(
        client.query(`UPDATE ${TABLE} SET organization_id = $2 WHERE id = $1`, [inviteA.id, orgB.orgId]),
        '42501',
      );
    });
  });

  test('positive control: organization A can create, update and revoke its own invitations', async () => {
    await asTenant(orgA.orgId, async (client) => {
      const created = await insertInvite(client, { organization_id: orgA.orgId, email: 'new@documind.test', invited_by: orgA.users.admin.id });
      expect(created.organization_id).toBe(orgA.orgId);
      const upd = await client.query(
        `UPDATE ${TABLE} SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1`,
        [inviteA.id, orgA.users.admin.id],
      );
      expect(upd.rowCount).toBe(1);
    });
  });

  test.each([
    ['no tenant setting at all', undefined],
    ['an empty tenant setting', ''],
  ])('%s returns zero rows and cannot insert', async (_label, tenant) => {
    await asTenant(tenant, async (client) => {
      const { rows } = await client.query(`SELECT id FROM ${TABLE}`);
      expect(rows).toEqual([]);
    });
    await asTenant(tenant, async (client) => {
      await expectPgError(insertInvite(client, { organization_id: orgA.orgId, email: 'none@documind.test' }), '42501');
    });
    expect(await countInvites()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('8. Test database cleanup', () => {
  test('truncateAll() removes invitation rows', async () => {
    await insertInvite(pool, { organization_id: orgA.orgId, email: 'c1@documind.test' });
    await insertInvite(pool, { organization_id: orgB.orgId, email: 'c2@documind.test' });
    expect(await countInvites()).toBe(2);

    await h.truncateAll();
    expect(await countInvites()).toBe(0);
  });

  test("TRUNCATE organizations … CASCADE (other suites' cleanup) also removes invitation rows", async () => {
    await insertInvite(pool, { organization_id: orgA.orgId, email: 'c3@documind.test' });
    await pool.query('TRUNCATE organizations, users, memberships CASCADE');
    expect(await countInvites()).toBe(0);
  });
});
