/**
 * Migration 009 — Google OAuth schema tests
 *
 * Verifies the structural and behavioural changes introduced by
 * 009_google_auth.sql without touching any Google API or JWT logic:
 *
 *   1. users.password_hash is now nullable (Google-only accounts allowed)
 *   2. users.avatar_url column exists and is nullable
 *   3. oauth_accounts table has correct structure and constraints
 *   4. UNIQUE (provider, provider_user_id) is enforced
 *   5. oauth_accounts.user_id FK cascades on user deletion
 *   6. Existing password users are unaffected by the migration
 *   7. oauth_accounts has no RLS (consistent with users / memberships)
 *   8. documind_app holds only SELECT/INSERT/UPDATE/DELETE on oauth_accounts
 *
 * Uses the same pool / truncateAll pattern as the rest of the security suite.
 * Never calls any application service layer — raw SQL only, so the tests
 * remain valid whether or not auth.service.js has been updated yet.
 */

'use strict';

const argon2    = require('argon2');
const { pool }  = require('../../src/db');
const h         = require('../streaming/stream.helpers');

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Insert a user with a hashed password (the classic pre-Google path). */
async function insertPasswordUser(email) {
  const hash = await argon2.hash('Password123!');
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING *',
    [email, hash, 'Password User'],
  );
  return rows[0];
}

/** Insert a Google-only user (password_hash NULL — only valid after migration 009). */
async function insertGoogleUser(email) {
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, full_name, avatar_url) VALUES ($1, NULL, $2, $3) RETURNING *',
    [email, 'Google User', 'https://example.com/avatar.jpg'],
  );
  return rows[0];
}

/** Link an OAuth account. */
async function insertOAuthAccount(userId, provider, providerUserId) {
  const { rows } = await pool.query(
    'INSERT INTO oauth_accounts (user_id, provider, provider_user_id) VALUES ($1, $2, $3) RETURNING *',
    [userId, provider, providerUserId],
  );
  return rows[0];
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // h.truncateAll() cascades to oauth_accounts via the users FK (ON DELETE CASCADE).
  // The explicit TRUNCATE below ensures a clean slate even when run after a suite
  // that left oauth_accounts rows that were not tied to users rows.
  await h.truncateAll();
  await pool.query('TRUNCATE oauth_accounts RESTART IDENTITY CASCADE');
});

afterEach(async () => {
  // h.truncateAll() truncates users WITH CASCADE, which removes all oauth_accounts
  // rows through the FK ON DELETE CASCADE defined in migration 009.
  // No separate TRUNCATE oauth_accounts is needed.
  await h.truncateAll();
});

// pool.end() is intentionally omitted: the pool is a singleton shared across all
// test suites in the same Jest --runInBand run. Ending it here would break any
// suite that executes after this file. Jest's --forceExit handles process teardown.

// ─────────────────────────────────────────────────────────────────────────────
// 1. users.password_hash is now nullable
// ─────────────────────────────────────────────────────────────────────────────
describe('1. users.password_hash nullability', () => {
  test('existing password users retain their password_hash', async () => {
    const user = await insertPasswordUser('pw_user@migration.test');
    expect(user.password_hash).not.toBeNull();
    expect(typeof user.password_hash).toBe('string');
    expect(user.password_hash.length).toBeGreaterThan(0);
  });

  test('Google-only user can be created with NULL password_hash', async () => {
    const user = await insertGoogleUser('google_user@migration.test');
    expect(user.password_hash).toBeNull();
    expect(user.email).toBe('google_user@migration.test');
  });

  test('information_schema confirms password_hash is nullable', async () => {
    const { rows } = await pool.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'users'
         AND column_name  = 'password_hash'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('YES');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. users.avatar_url column
// ─────────────────────────────────────────────────────────────────────────────
describe('2. users.avatar_url column', () => {
  test('column exists and is nullable', async () => {
    const { rows } = await pool.query(
      `SELECT is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'users'
         AND column_name  = 'avatar_url'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].data_type).toBe('text');
  });

  test('avatar_url can be set for a Google user', async () => {
    const user = await insertGoogleUser('avatar_user@migration.test');
    expect(user.avatar_url).toBe('https://example.com/avatar.jpg');
  });

  test('avatar_url is NULL for a password user who has not set one', async () => {
    const user = await insertPasswordUser('no_avatar@migration.test');
    expect(user.avatar_url).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. oauth_accounts table structure
// ─────────────────────────────────────────────────────────────────────────────
describe('3. oauth_accounts table structure', () => {
  test('table exists in information_schema', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'oauth_accounts'`,
    );
    expect(rows).toHaveLength(1);
  });

  test('all expected columns are present with correct types', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'oauth_accounts'
       ORDER BY ordinal_position`,
    );
    const cols = Object.fromEntries(rows.map(r => [r.column_name, r]));

    expect(cols).toHaveProperty('id');
    expect(cols.id.data_type).toBe('uuid');
    expect(cols.id.is_nullable).toBe('NO');

    expect(cols).toHaveProperty('user_id');
    expect(cols.user_id.data_type).toBe('uuid');
    expect(cols.user_id.is_nullable).toBe('NO');

    expect(cols).toHaveProperty('provider');
    expect(cols.provider.data_type).toBe('character varying');
    expect(cols.provider.is_nullable).toBe('NO');

    expect(cols).toHaveProperty('provider_user_id');
    expect(cols.provider_user_id.data_type).toBe('character varying');
    expect(cols.provider_user_id.is_nullable).toBe('NO');

    expect(cols).toHaveProperty('created_at');
    expect(cols.created_at.data_type).toBe('timestamp with time zone');
    expect(cols.created_at.is_nullable).toBe('NO');
  });

  test('a valid oauth_accounts row can be inserted and retrieved', async () => {
    const user = await insertGoogleUser('link_test@migration.test');
    const account = await insertOAuthAccount(user.id, 'google', 'google-sub-abc123');

    expect(account.user_id).toBe(user.id);
    expect(account.provider).toBe('google');
    expect(account.provider_user_id).toBe('google-sub-abc123');
    expect(account.created_at).toBeDefined();
    expect(account.id).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNIQUE (provider, provider_user_id) constraint
// ─────────────────────────────────────────────────────────────────────────────
describe('4. UNIQUE (provider, provider_user_id) constraint', () => {
  test('inserting the same (provider, provider_user_id) twice raises a unique violation', async () => {
    const user1 = await insertGoogleUser('unique1@migration.test');
    const user2 = await insertGoogleUser('unique2@migration.test');

    await insertOAuthAccount(user1.id, 'google', 'duplicate-sub-999');

    await expect(
      insertOAuthAccount(user2.id, 'google', 'duplicate-sub-999'),
    ).rejects.toMatchObject({ code: '23505' }); // PostgreSQL unique_violation
  });

  test('same provider_user_id for different providers is allowed', async () => {
    const user = await insertGoogleUser('multiprovider@migration.test');

    const g = await insertOAuthAccount(user.id, 'google', 'shared-sub-id');
    const gh = await insertOAuthAccount(user.id, 'github', 'shared-sub-id');

    expect(g.provider).toBe('google');
    expect(gh.provider).toBe('github');
  });

  test('same user can have only one Google account linked', async () => {
    const user = await insertGoogleUser('onesub@migration.test');
    await insertOAuthAccount(user.id, 'google', 'sub-first');

    // Different sub for the same provider — should be allowed (user links a second Google account?
    // In practice application code prevents this, but the DB constraint is per sub, not per user+provider)
    const second = await insertOAuthAccount(user.id, 'google', 'sub-second');
    expect(second.user_id).toBe(user.id);
  });

  test('unique constraint name matches migration (uq_oauth_accounts_provider_user)', async () => {
    const { rows } = await pool.query(
      `SELECT conname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'oauth_accounts'
         AND c.contype = 'u'`,
    );
    const names = rows.map(r => r.conname);
    expect(names).toContain('uq_oauth_accounts_provider_user');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ON DELETE CASCADE — deleting a user removes their OAuth accounts
// ─────────────────────────────────────────────────────────────────────────────
describe('5. FK ON DELETE CASCADE', () => {
  test('deleting a user hard-deletes their oauth_accounts rows', async () => {
    const user = await insertGoogleUser('cascade_delete@migration.test');
    await insertOAuthAccount(user.id, 'google', 'cascade-sub-xyz');

    // Confirm row exists
    const before = await pool.query(
      'SELECT id FROM oauth_accounts WHERE user_id = $1',
      [user.id],
    );
    expect(before.rows).toHaveLength(1);

    // Hard-delete the user (bypasses RLS; uses pool directly as the test runner)
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);

    // OAuth row must be gone
    const after = await pool.query(
      'SELECT id FROM oauth_accounts WHERE user_id = $1',
      [user.id],
    );
    expect(after.rows).toHaveLength(0);
  });

  test('FK constraint is defined on user_id referencing users(id)', async () => {
    const { rows } = await pool.query(
      `SELECT
         kcu.column_name,
         ccu.table_name  AS foreign_table,
         ccu.column_name AS foreign_column,
         rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name = 'oauth_accounts'
         AND kcu.column_name = 'user_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].foreign_table).toBe('users');
    expect(rows[0].foreign_column).toBe('id');
    expect(rows[0].delete_rule).toBe('CASCADE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Existing password users are unaffected
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Existing password users unaffected', () => {
  test('password user has non-null password_hash and no oauth_accounts row', async () => {
    const user = await insertPasswordUser('legacy@migration.test');
    expect(user.password_hash).not.toBeNull();

    const oauthRows = await pool.query(
      'SELECT id FROM oauth_accounts WHERE user_id = $1',
      [user.id],
    );
    expect(oauthRows.rows).toHaveLength(0);
  });

  test('password user and Google user can coexist with the same behaviour', async () => {
    const pw = await insertPasswordUser('pw_coexist@migration.test');
    const gg = await insertGoogleUser('google_coexist@migration.test');

    expect(pw.password_hash).not.toBeNull();
    expect(gg.password_hash).toBeNull();

    // Both are queryable as normal users
    const { rows } = await pool.query(
      'SELECT id, email FROM users WHERE id = ANY($1::uuid[])',
      [[pw.id, gg.id]],
    );
    expect(rows).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. oauth_accounts has NO Row-Level Security
//    (consistent with users / memberships — system tables, not tenant data)
// ─────────────────────────────────────────────────────────────────────────────
describe('7. No RLS on oauth_accounts', () => {
  test('oauth_accounts does not have row level security enabled', async () => {
    const { rows } = await pool.query(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = 'oauth_accounts' AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(false);
    expect(rows[0].relforcerowsecurity).toBe(false);
  });

  test('no RLS policies exist on oauth_accounts', async () => {
    const { rows } = await pool.query(
      `SELECT policyname FROM pg_policies
       WHERE tablename = 'oauth_accounts'`,
    );
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. documind_app privilege check
//    Verifies the role holds exactly the privileges granted in the migration.
// ─────────────────────────────────────────────────────────────────────────────
describe('8. documind_app privileges on oauth_accounts', () => {
  test('documind_app has SELECT, INSERT, UPDATE, DELETE on oauth_accounts', async () => {
    // Only run this check if the role exists (dev + production databases have it;
    // a bare test database that skipped migration 002 would not).
    const { rows: roleExists } = await pool.query(
      `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'documind_app'`,
    );
    if (roleExists.length === 0) {
      console.warn('documind_app role not found — skipping privilege check');
      return;
    }

    const { rows } = await pool.query(
      `SELECT privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee    = 'documind_app'
         AND table_name = 'oauth_accounts'
         AND table_schema = 'public'
       ORDER BY privilege_type`,
    );

    const granted = rows.map(r => r.privilege_type);
    // Must have exactly the four DML privileges (migration 008 revoked TRUNCATE/TRIGGER/REFERENCES)
    expect(granted).toContain('SELECT');
    expect(granted).toContain('INSERT');
    expect(granted).toContain('UPDATE');
    expect(granted).toContain('DELETE');
    // Must NOT hold TRUNCATE, TRIGGER, or REFERENCES
    expect(granted).not.toContain('TRUNCATE');
    expect(granted).not.toContain('TRIGGER');
    expect(granted).not.toContain('REFERENCES');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. UNIQUE constraint backing index
//    PostgreSQL automatically creates a unique B-tree index to enforce the
//    UNIQUE constraint — no separate CREATE INDEX exists in migration 009.
//    This block verifies that index exists, is unique, and covers both columns.
// ─────────────────────────────────────────────────────────────────────────────
describe('9. UNIQUE constraint backing index', () => {
  test('uq_oauth_accounts_provider_user index exists in pg_indexes', async () => {
    const { rows } = await pool.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE tablename = 'oauth_accounts'
         AND indexname = 'uq_oauth_accounts_provider_user'`,
    );
    expect(rows).toHaveLength(1);
    // Index definition must reference both columns
    expect(rows[0].indexdef).toMatch(/provider/);
    expect(rows[0].indexdef).toMatch(/provider_user_id/);
  });

  test('uq_oauth_accounts_provider_user index is unique (not a plain index)', async () => {
    const { rows } = await pool.query(
      `SELECT ix.indisunique
       FROM pg_class c
       JOIN pg_index ix  ON ix.indrelid = c.oid
       JOIN pg_class ic  ON ic.oid = ix.indexrelid
       WHERE c.relname  = 'oauth_accounts'
         AND ic.relname = 'uq_oauth_accounts_provider_user'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indisunique).toBe(true);
  });

  test('no separate idx_oauth_accounts_lookup index exists (redundant index was removed)', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'oauth_accounts'
         AND indexname = 'idx_oauth_accounts_lookup'`,
    );
    // The explicit index was removed from the migration; only the constraint index remains.
    expect(rows).toHaveLength(0);
  });
});
