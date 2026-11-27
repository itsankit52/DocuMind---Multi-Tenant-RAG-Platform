-- Migration 011: case-insensitive email uniqueness for users (Phase 3.3 / F5)
--
-- Problem: migration 001 declared `email VARCHAR(255) NOT NULL UNIQUE`, which is
-- case-sensitive. The application normalizes emails (registration and login: JS trim() +
-- toLowerCase(); user lookup: lower(email) = lower($1); invitation matching: trim + lower),
-- but a legacy or external write could store a case/space variant of an existing address,
-- making findByEmail() and invitation email matching ambiguous.
--
-- Change: a UNIQUE expression index on lower(btrim(email)). The database now enforces the
-- invariant itself, whatever client writes the row.
--   * Matches the application policy for every address the API accepts: zod's email check
--     rejects internal whitespace and non-ASCII, so trim() and toLowerCase() reduce to
--     btrim() (spaces) and lower() (ASCII). Not identical for exotic input written outside
--     the API: btrim() trims only spaces (not tabs/newlines), and lower() of non-ASCII follows
--     the database collation (en_US.utf8 locally).
--   * The original case-sensitive users_email_key is KEPT (no behaviour change for existing
--     code paths and error mapping; it is implied by the new index).
--   * No CHECK forcing stored emails to be normalized: existing rows and tests may hold
--     untrimmed or mixed-case values, which remain valid as long as they are unique.
--
-- Preconditions (verified below, inside this migration's transaction): no two rows share
-- lower(btrim(email)). If any do, the migration aborts WITHOUT changing anything and reports
-- only the number of groups (never the addresses). Duplicates are never merged or deleted
-- automatically: they need a manual identity decision.
--
-- Locking: CREATE INDEX (not CONCURRENTLY: the runner wraps each file in a transaction)
-- blocks writes to users for the duration of the build; users is small.
-- Idempotent: IF NOT EXISTS; the runner applies each file once (schema_migrations).
--
-- Rollback (manual, by the schema owner): DROP INDEX IF EXISTS uidx_users_email_normalized;
-- then delete the schema_migrations row for this file. Rows written while the index existed
-- stay valid afterwards. Rolling back re-opens the F5 ambiguity.

DO $$
DECLARE
    duplicate_groups integer;
BEGIN
    SELECT count(*) INTO duplicate_groups
    FROM (SELECT 1 FROM users GROUP BY lower(btrim(email)) HAVING count(*) > 1) d;
    IF duplicate_groups > 0 THEN
        RAISE EXCEPTION 'F5 precondition failed: % case-insensitive duplicate email group(s) in users; resolve them manually before applying migration 011', duplicate_groups;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_users_email_normalized ON users (lower(btrim(email)));

-- Verification: the index exists, is unique and valid, and has exactly the intended expression.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'uidx_users_email_normalized'
          AND i.indrelid = 'public.users'::regclass
          AND i.indisunique AND i.indisvalid
          AND pg_get_indexdef(i.indexrelid) LIKE '%(lower(btrim((email)::text)))%'
    ) THEN
        RAISE EXCEPTION 'F5 verification failed: uidx_users_email_normalized is missing or not as designed';
    END IF;
END $$;
