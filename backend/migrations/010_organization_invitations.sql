-- Migration 010: Organization invitations (schema only)
--
-- Invitation-based joining: an organization admin invites an email address with a role;
-- the invitee accepts with a single-use token. Only a SHA-256 hash of the token is stored.
--
-- Security model:
--   * Tenant table: ENABLE + FORCE ROW LEVEL SECURITY with the same tenant_isolation policy
--     as every other tenant table (app.current_tenant). Admin create/list/revoke run inside
--     withTenantTransaction() as documind_app, where RLS is enforced.
--   * Token lookup and acceptance happen before the invitee is a member, so they run as
--     documind_runtime (BYPASSRLS) outside a tenant transaction, always filtered by
--     token_hash, exactly like the existing memberships lookups.
--   * Least privilege: documind_app gets SELECT/INSERT/UPDATE/DELETE only (no TRUNCATE,
--     TRIGGER or REFERENCES, per 008). documind_runtime gets direct SELECT/UPDATE only
--     (lookup + mark accepted/expired); the INSERT/DELETE that the schema owner's default
--     privileges (007) would grant directly are revoked on this table.
--     NOTE: documind_runtime is a member of documind_app WITH INHERIT, so its effective
--     privileges still include documind_app's grants. Narrowing that is a role-membership
--     change and out of scope here.
--   * No existing table, policy, role or migration is modified.
--
-- Idempotent: IF NOT EXISTS / DROP ... IF EXISTS guards throughout.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_invitations (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(20)  NOT NULL,
    token_hash      CHAR(64)     NOT NULL,          -- SHA-256 hex of the token; the raw token is never stored
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
    invited_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
    accepted_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
    revoked_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ  NOT NULL,
    accepted_at     TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_org_invitations_token_hash UNIQUE (token_hash),

    -- Stored normalized so lookups and the pending-email index are case/whitespace-insensitive
    CONSTRAINT chk_org_invitations_email
        CHECK (email = lower(btrim(email)) AND email <> ''),
    -- Same role set as memberships
    CONSTRAINT chk_org_invitations_role
        CHECK (role IN ('admin', 'member', 'viewer')),
    CONSTRAINT chk_org_invitations_status
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    -- 64 lowercase hex characters (SHA-256)
    CONSTRAINT chk_org_invitations_token_hash
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_org_invitations_expiry
        CHECK (expires_at > created_at),
    -- accepted_at / revoked_at are set exactly when the status says so. (accepted_by /
    -- revoked_by are not tied to status: ON DELETE SET NULL may clear them later.)
    CONSTRAINT chk_org_invitations_accepted
        CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
    CONSTRAINT chk_org_invitations_revoked
        CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Indexes
-- ─────────────────────────────────────────────────────────────────────────────
-- At most one live (pending) invitation per email per organization; accepted, revoked
-- and expired rows are kept as history. A pending row past expires_at must be marked
-- 'expired' before a new invitation for the same email can be created.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_org_invitations_pending_email
    ON organization_invitations (organization_id, email)
    WHERE status = 'pending';

-- Admin listing: invitations of one organization by status, newest/oldest first
CREATE INDEX IF NOT EXISTS idx_org_invitations_org_status
    ON organization_invitations (organization_id, status, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Row-Level Security (same pattern as 001 / 003)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_organization_invitations ON organization_invitations;
CREATE POLICY tenant_isolation_organization_invitations ON organization_invitations
    USING (organization_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Privileges
--    Explicit grants (ALTER DEFAULT PRIVILEGES only covers tables created by the role that
--    set them), then revoke anything beyond the intended set on this table.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE organization_invitations FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_app') THEN
        REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE organization_invitations FROM documind_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE organization_invitations TO documind_app;
    END IF;

    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_runtime') THEN
        REVOKE INSERT, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE organization_invitations FROM documind_runtime;
        GRANT SELECT, UPDATE ON TABLE organization_invitations TO documind_runtime;
    END IF;
END $$;
