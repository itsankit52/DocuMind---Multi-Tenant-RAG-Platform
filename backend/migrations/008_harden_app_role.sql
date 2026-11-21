-- Audit hardening: documind_app is only ever a `SET LOCAL ROLE` target inside tenant
-- transactions (src/db/transaction.js); nothing logs in as it.
--   * NOLOGIN in every environment, so the development password from 002 ('app_password')
--     can never be used to connect (migrate.js previously did this only in production).
--   * Least privilege: RLS does not govern TRUNCATE, TRIGGER or REFERENCES, so an RLS-bound
--     role must not hold them. Keep exactly SELECT/INSERT/UPDATE/DELETE on tables.
ALTER ROLE documind_app NOLOGIN;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM documind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM documind_app;
