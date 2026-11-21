-- Step 14: least-privilege runtime login role for the API and worker.
--
-- The containers no longer connect as the database owner/superuser. documind_runtime:
--   * NOSUPERUSER / NOCREATEDB / NOCREATEROLE — cannot run DDL, read server files or create roles
--   * member of documind_app so withTenantTransaction() can `SET LOCAL ROLE documind_app`,
--     where RLS (FORCE ROW LEVEL SECURITY + tenant policies) is enforced exactly as before
--   * BYPASSRLS only for system paths that run outside a tenant transaction (auth lookups,
--     outbox relay, worker job bookkeeping) — the same visibility those paths had as superuser.
--     BYPASSRLS is evaluated for the *current* role, so it does not apply after SET ROLE.
-- Its password is set by migrate.js from DB_RUNTIME_PASSWORD (never stored in SQL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'documind_runtime') THEN
    CREATE ROLE documind_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;

GRANT documind_app TO documind_runtime;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO documind_runtime', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO documind_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO documind_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO documind_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO documind_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO documind_runtime;
