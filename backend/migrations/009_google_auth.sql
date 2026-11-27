-- Migration 009: Google OAuth account support
--
-- Extends the users table and adds the oauth_accounts linking table so users can
-- authenticate via Google Identity Services (and future OAuth providers) without
-- breaking existing email/password accounts.
--
-- Three changes:
--   1. users.password_hash → nullable (Google-only accounts have no password)
--   2. users.avatar_url    → optional profile picture URL from the OAuth provider
--   3. oauth_accounts      → provider-scoped identity link (provider + sub → user)
--
-- Security model mirrors the existing system tables (users, memberships):
--   * No RLS — oauth_accounts is a system table scoped to a single user, not a tenant.
--     Auth lookups run as documind_runtime (BYPASSRLS), the same role that reads users
--     and memberships directly outside withTenantTransaction().
--   * documind_app receives SELECT/INSERT/UPDATE/DELETE only (no TRUNCATE/TRIGGER/REFERENCES)
--     consistent with migration 008_harden_app_role.sql.
--   * No new database roles are created.
--   * No existing RLS policies, tenant isolation, RBAC, or role privileges are modified.
--
-- Idempotency: each DDL statement is guarded with IF NOT EXISTS / IF EXISTS / DROP NOT NULL
-- so the migration can be re-applied to a database that already has some of these changes
-- without error (e.g. during test-database recreation).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Allow password_hash to be NULL
--    Google-only users are created without a password. Existing rows are unaffected:
--    their password_hash values remain set. The NOT NULL constraint was introduced in
--    migration 001; dropping it here is the correct additive change.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add optional avatar_url to users
--    Stores the profile picture URL returned by the OAuth provider. NULL for
--    email/password users who have not set an avatar.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'avatar_url'
    ) THEN
        ALTER TABLE users ADD COLUMN avatar_url TEXT;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. OAuth accounts table
--    Maps a (provider, provider_user_id) pair to a DocuMind user.
--    One user may have multiple providers (e.g. Google + GitHub in the future).
--    One provider identity maps to exactly one user (UNIQUE constraint).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_accounts (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         VARCHAR(50) NOT NULL,
    provider_user_id VARCHAR(255) NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One provider identity → exactly one DocuMind user.
    -- Prevents two accounts being linked to the same Google sub.
    -- PostgreSQL automatically creates a unique B-tree index backing this constraint,
    -- covering (provider, provider_user_id) — no separate CREATE INDEX is needed.
    CONSTRAINT uq_oauth_accounts_provider_user UNIQUE (provider, provider_user_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Privileges for oauth_accounts
--    Mirror migration 003 and 006: explicit grants on the new table for both
--    application roles, since ALTER DEFAULT PRIVILEGES (migration 002) only
--    covers tables created AFTER that grant was issued — not this new table.
--
--    documind_app  : SELECT/INSERT/UPDATE/DELETE only (no TRUNCATE/TRIGGER/REFERENCES
--                    per the least-privilege hardening in migration 008).
--    documind_runtime: inherits documind_app via GRANT documind_app TO documind_runtime
--                    (migration 007), so no separate grant is needed.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oauth_accounts TO documind_app;
    END IF;
END $$;
