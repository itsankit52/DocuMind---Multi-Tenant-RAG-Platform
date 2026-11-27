-- Migration 014: forward correction to 013 — discovery function executable by documind_worker only
--
-- 013 granted EXECUTE on public.worker_stale_job_candidates(integer, integer) to documind_worker
-- AND documind_runtime (a transition allowance for workers still logging in as runtime). Review
-- decision: documind_worker only. 013 is already applied (its checksum is recorded), so it is
-- left byte-for-byte unchanged and this migration revokes the extra grant.
--
-- Consequence: a worker that still connects as documind_runtime cannot run stale-job recovery
-- with the current code (the sweep logs an error and retries next interval; job processing is
-- unaffected). The worker must use WORKER_DATABASE_URL (documind_worker) before this code ships.
--
-- Prerequisites: 013. Idempotent (REVOKE of an absent privilege is a no-op).
-- Rollback (manual, schema owner): GRANT EXECUTE ON FUNCTION
--   public.worker_stale_job_candidates(integer, integer) TO documind_runtime; delete this row
--   from schema_migrations.

REVOKE EXECUTE ON FUNCTION public.worker_stale_job_candidates(integer, integer) FROM documind_runtime;
REVOKE ALL ON FUNCTION public.worker_stale_job_candidates(integer, integer) FROM PUBLIC;

-- ─── Verification: exactly owner + documind_worker may execute ────────────────
DO $$
DECLARE
    fn regprocedure := 'public.worker_stale_job_candidates(integer, integer)'::regprocedure;
    grantees text[];
BEGIN
    SELECT array_agg(g.name ORDER BY g.name)
      INTO grantees
      FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS name
              FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.oid = fn AND a.privilege_type = 'EXECUTE') AS g;
    IF grantees IS DISTINCT FROM ARRAY['documind_worker', 'documind_worker_router'] THEN
        RAISE EXCEPTION 'F2 verification: EXECUTE grantees must be documind_worker (+ owner) only, found %', grantees;
    END IF;
    IF has_function_privilege('documind_runtime', fn, 'EXECUTE')
       OR has_function_privilege('documind_api', fn, 'EXECUTE')
       OR has_function_privilege('documind_app', fn, 'EXECUTE')
       OR has_function_privilege('documind_token_router', fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'F2 verification: a non-worker role can still execute the discovery function';
    END IF;
END $$;
