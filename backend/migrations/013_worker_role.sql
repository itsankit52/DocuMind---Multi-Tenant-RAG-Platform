-- Migration 013: dedicated least-privilege worker role (Phase 3.4 / F2, Option A)
--
-- Before: the background worker logs in as documind_runtime (BYPASSRLS). Job lookup/claim,
-- retry and failure updates, stale-job recovery and its outbox/document/audit writes ran on
-- the raw pool and bypassed RLS.
--
-- After (application code in the same change): every tenant-owned read/write of the worker runs
-- inside withTenantTransaction(org) — SET LOCAL ROLE documind_app + transaction-local tenant —
-- with the org taken from the queue message and PROVEN by RLS (a job of another organization is
-- invisible, i.e. "not found"). The single genuinely cross-tenant need — discovering abandoned
-- jobs during the periodic recovery sweep, when no tenant exists — is served by one read-only
-- SECURITY DEFINER function that returns only (job_id, organization_id) pairs.
--
-- ADDITIVE: documind_runtime, documind_app, documind_api and documind_token_router are not
-- changed, except that documind_runtime is granted EXECUTE on the discovery function, so a
-- worker that still connects as documind_runtime (production until a planned cutover) keeps
-- working with the new recovery code.
--
-- 1. documind_worker_router — NOLOGIN, NOINHERIT, no members, no BYPASSRLS. Owns the discovery
--    function; may read exactly five columns of document_processing_jobs through a SELECT-only
--    policy that applies to this role alone.
-- 2. worker_stale_job_candidates(int, int) — SECURITY DEFINER, STABLE, STRICT, fixed
--    search_path, no dynamic SQL, takes no lock and writes nothing. The predicate is exactly the
--    staleness rule of workers/job-recovery.js; the caller re-checks it under FOR UPDATE SKIP
--    LOCKED inside the job's tenant transaction, so this function never decides anything.
--    Inputs are clamped (timeout >= 1 minute, 1 <= limit <= 500). Output: job id and
--    organization id only — no document, filename, status, error text or attempts.
-- 3. documind_worker — LOGIN (password NULL: unusable until one is set out of band), NOSUPERUSER,
--    NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOINHERIT. Member of documind_app WITH
--    INHERIT FALSE, SET TRUE: tenant work only inside SET LOCAL ROLE documind_app. Direct
--    privileges: CONNECT, schema USAGE, SELECT/UPDATE on outbox_events (the relay: no RLS, ids-
--    only payloads), EXECUTE on the discovery function. Nothing on any RLS table, users,
--    memberships, organizations or oauth_accounts.
--
-- Prerequisites: migrations 001–012; run by the schema owner (creates roles, assigns ownership).
-- Idempotent: roles created only if missing, attributes re-asserted, policy dropped/recreated,
-- function CREATE OR REPLACE, grants re-applied.
-- Rollback (manual, schema owner, once no documind_worker sessions exist and the worker is back
-- on DATABASE_URL): DROP FUNCTION public.worker_stale_job_candidates(integer, integer);
--   DROP POLICY worker_router_stale_scan ON document_processing_jobs;
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM documind_worker, documind_worker_router;
--   REVOKE USAGE ON SCHEMA public FROM documind_worker, documind_worker_router;
--   REVOKE CONNECT ON DATABASE <db> FROM documind_worker; REVOKE documind_app FROM documind_worker;
--   DROP ROLE documind_worker; DROP ROLE documind_worker_router; delete this file's
--   schema_migrations row. The application then needs the previous job-recovery.js (it calls the
--   function).

-- ─── 1. Discovery-function owner ─────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'documind_worker_router') THEN
        CREATE ROLE documind_worker_router NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
    END IF;
END $$;
ALTER ROLE documind_worker_router NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

GRANT USAGE ON SCHEMA public TO documind_worker_router;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM documind_worker_router;
GRANT SELECT (id, organization_id, status, locked_at, updated_at) ON document_processing_jobs TO documind_worker_router;

DROP POLICY IF EXISTS worker_router_stale_scan ON document_processing_jobs;
CREATE POLICY worker_router_stale_scan ON document_processing_jobs
    AS PERMISSIVE FOR SELECT TO documind_worker_router USING (true);

-- ─── 2. Discovery function ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.worker_stale_job_candidates(p_lock_timeout_minutes integer, p_limit integer)
RETURNS TABLE (job_id uuid, organization_id uuid)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT j.id, j.organization_id
    FROM public.document_processing_jobs AS j
    WHERE (j.status = 'processing'
           AND COALESCE(j.locked_at, j.updated_at) < now() - make_interval(mins => GREATEST(p_lock_timeout_minutes, 1)))
       OR (j.status IN ('pending', 'queued', 'retrying')
           AND j.updated_at < now() - make_interval(mins => GREATEST(p_lock_timeout_minutes, 1)))
    ORDER BY j.updated_at
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

ALTER FUNCTION public.worker_stale_job_candidates(integer, integer) OWNER TO documind_worker_router;
REVOKE ALL ON FUNCTION public.worker_stale_job_candidates(integer, integer) FROM PUBLIC;

-- ─── 3. Worker login role ────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'documind_worker') THEN
        CREATE ROLE documind_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO documind_worker', current_database());
END $$;
ALTER ROLE documind_worker NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

GRANT documind_app TO documind_worker WITH INHERIT FALSE, SET TRUE;

GRANT USAGE ON SCHEMA public TO documind_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM documind_worker;
GRANT SELECT, UPDATE ON outbox_events TO documind_worker;

-- documind_runtime keeps working during the transition (the worker may still log in as it).
GRANT EXECUTE ON FUNCTION public.worker_stale_job_candidates(integer, integer) TO documind_worker, documind_runtime;

-- ─── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
    r record;
BEGIN
    SELECT rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole INTO r FROM pg_roles WHERE rolname = 'documind_worker';
    IF r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole THEN
        RAISE EXCEPTION 'F2 verification: documind_worker attributes are not as designed';
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members m WHERE m.member = 'documind_worker'::regrole
               AND (m.roleid <> 'documind_app'::regrole OR m.inherit_option OR NOT m.set_option OR m.admin_option)) THEN
        RAISE EXCEPTION 'F2 verification: documind_worker may only SET ROLE documind_app (no inherit, no admin)';
    END IF;
    SELECT rolsuper, rolbypassrls, rolcanlogin INTO r FROM pg_roles WHERE rolname = 'documind_worker_router';
    IF r.rolsuper OR r.rolbypassrls OR r.rolcanlogin THEN
        RAISE EXCEPTION 'F2 verification: documind_worker_router must be NOLOGIN, not superuser or BYPASSRLS';
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members WHERE roleid = 'documind_worker_router'::regrole) THEN
        RAISE EXCEPTION 'F2 verification: documind_worker_router must have no members';
    END IF;
    IF EXISTS (
        SELECT FROM information_schema.role_table_grants g
        JOIN pg_class c ON c.relname = g.table_name AND c.relnamespace = 'public'::regnamespace
        WHERE g.grantee = 'documind_worker' AND g.table_schema = 'public'
          AND (c.relrowsecurity OR g.table_name <> 'outbox_events')
    ) THEN
        RAISE EXCEPTION 'F2 verification: documind_worker may hold direct privileges on outbox_events only';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.worker_stale_job_candidates(integer, integer)'::regprocedure) THEN
        RAISE EXCEPTION 'F2 verification: discovery function must be SECURITY DEFINER';
    END IF;
END $$;
