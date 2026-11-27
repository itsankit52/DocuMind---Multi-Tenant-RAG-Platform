-- Migration 012: least-privilege API role and restricted invitation token routing (Phase 3.3 / F2)
--
-- Before: the API and the worker both log in as documind_runtime (NOSUPERUSER, BYPASSRLS,
-- member of documind_app WITH INHERIT). Every query on the raw pool — outside
-- withTenantTransaction() — bypasses RLS on every tenant table.
--
-- This migration is ADDITIVE. documind_runtime is NOT changed, so an environment that still
-- logs in as documind_runtime (production today, the worker everywhere) behaves exactly as
-- before. Switching the API process to documind_api is a separate, explicitly planned
-- deployment step (set its password out of band; point the API's DATABASE_URL at it).
--
-- 1. documind_token_router — NOLOGIN, NOINHERIT, no members, no BYPASSRLS. It owns the
--    routing function and may read exactly two columns of organization_invitations through a
--    SELECT-only RLS policy that applies to this role alone.
-- 2. invitation_organization_for_token_hash(text) — SECURITY DEFINER, fixed search_path, no
--    dynamic SQL. Input: a 64-hex SHA-256 token hash; output: that invitation's organization_id
--    or NULL. Exact equality only; malformed input returns NULL without touching the table.
--    Returns no email, id, token, status or organization data. EXECUTE: documind_api and
--    documind_runtime only (the application uses it under either login).
-- 3. documind_api — LOGIN (password NULL: unusable until one is set out of band), NOSUPERUSER,
--    NOBYPASSRLS, NOCREATEDB, NOCREATEROLE. Member of documind_app WITH INHERIT FALSE, SET TRUE:
--    it can SET ROLE documind_app inside withTenantTransaction (RLS enforced), but holds none of
--    documind_app's privileges outside it. Direct grants only on the non-RLS global tables the
--    API reads/writes before a tenant is chosen (auth, membership checks, organization creation,
--    member management, outbox publish marking). NO direct privilege on any tenant table.
--    It cannot SET ROLE to documind_admin, documind_runtime or documind_token_router.
--
-- Prerequisites: migrations 001–011; run by the schema owner (superuser locally), because it
-- creates roles and assigns function ownership.
-- Idempotent: roles are created only if missing; grants/policy/function are re-creatable.
-- Rollback (manual, schema owner): DROP FUNCTION public.invitation_organization_for_token_hash(text);
--   DROP POLICY token_router_lookup ON organization_invitations; REVOKE ALL ON ALL TABLES IN SCHEMA
--   public FROM documind_api, documind_token_router; REVOKE USAGE ON SCHEMA public FROM both;
--   REVOKE CONNECT ON DATABASE <db> FROM documind_api; DROP ROLE documind_api; DROP ROLE
--   documind_token_router; delete this file's schema_migrations row. Application code also works
--   without the function only if repository routing is reverted (it calls the function).

-- ─── 1. Token router (function owner) ────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'documind_token_router') THEN
        CREATE ROLE documind_token_router NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;
ALTER ROLE documind_token_router NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO documind_token_router;
REVOKE ALL ON organization_invitations FROM documind_token_router;
GRANT SELECT (token_hash, organization_id) ON organization_invitations TO documind_token_router;

DROP POLICY IF EXISTS token_router_lookup ON organization_invitations;
CREATE POLICY token_router_lookup ON organization_invitations
    AS PERMISSIVE FOR SELECT TO documind_token_router USING (true);

-- ─── 2. Routing function ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invitation_organization_for_token_hash(p_token_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT i.organization_id
    FROM public.organization_invitations AS i
    WHERE p_token_hash ~ '^[0-9a-f]{64}$'
      AND i.token_hash = p_token_hash::bpchar
$$;

ALTER FUNCTION public.invitation_organization_for_token_hash(text) OWNER TO documind_token_router;
REVOKE ALL ON FUNCTION public.invitation_organization_for_token_hash(text) FROM PUBLIC;

-- ─── 3. API role ─────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'documind_api') THEN
        CREATE ROLE documind_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO documind_api', current_database());
END $$;
ALTER ROLE documind_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- SET ROLE documind_app only (tenant transactions); no inherited privileges outside them.
GRANT documind_app TO documind_api WITH INHERIT FALSE, SET TRUE;

GRANT USAGE ON SCHEMA public TO documind_api;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM documind_api;
-- users: authentication, registration, lookups (no UPDATE/DELETE in the API outside tenant transactions)
GRANT SELECT, INSERT ON users TO documind_api;
-- organizations: creation, slug lookup, membership joins; UPDATE is required only for the
-- FOR NO KEY UPDATE organization lock taken by member management
GRANT SELECT, INSERT, UPDATE ON organizations TO documind_api;
-- memberships: tenant middleware checks, organization creation, member add / role change
GRANT SELECT, INSERT, UPDATE ON memberships TO documind_api;
-- outbox_events: the API marks events it just published (rows are created inside tenant transactions)
GRANT SELECT, UPDATE ON outbox_events TO documind_api;

GRANT EXECUTE ON FUNCTION public.invitation_organization_for_token_hash(text) TO documind_api, documind_runtime;

-- ─── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
    r record;
BEGIN
    SELECT rolsuper, rolbypassrls, rolcanlogin INTO r FROM pg_roles WHERE rolname = 'documind_api';
    IF r.rolsuper OR r.rolbypassrls THEN RAISE EXCEPTION 'F2 verification: documind_api must not be superuser or BYPASSRLS'; END IF;
    SELECT rolsuper, rolbypassrls, rolcanlogin INTO r FROM pg_roles WHERE rolname = 'documind_token_router';
    IF r.rolsuper OR r.rolbypassrls OR r.rolcanlogin THEN RAISE EXCEPTION 'F2 verification: documind_token_router must be NOLOGIN, not superuser or BYPASSRLS'; END IF;
    IF EXISTS (SELECT FROM pg_auth_members WHERE roleid = 'documind_token_router'::regrole) THEN
        RAISE EXCEPTION 'F2 verification: documind_token_router must have no members';
    END IF;
    IF EXISTS (
        SELECT FROM information_schema.role_table_grants g
        JOIN pg_class c ON c.relname = g.table_name AND c.relnamespace = 'public'::regnamespace
        WHERE g.grantee = 'documind_api' AND g.table_schema = 'public' AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'F2 verification: documind_api must hold no direct privilege on an RLS table';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.invitation_organization_for_token_hash(text)'::regprocedure) THEN
        RAISE EXCEPTION 'F2 verification: routing function must be SECURITY DEFINER';
    END IF;
END $$;
