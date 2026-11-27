/**
 * DocuMind migration runner.
 *
 *   npm run migrate                 (development: uses DATABASE_URL)
 *   docker compose -f docker-compose.prod.yml run --rm migrate   (production)
 *
 * - Ordered: applies migrations/NNN_*.sql in filename order.
 * - Tracked: each applied file is recorded in schema_migrations with its SHA-256; applied files
 *   are skipped. An applied file whose content changed aborts the run (add a new migration instead).
 * - Transactional: each file runs in its own transaction, so a failure leaves no partial file applied.
 * - Serialized: a PostgreSQL advisory lock prevents two runners (e.g. two deploys) racing.
 * - Never drops or recreates the database.
 *
 * Connects with MIGRATION_DATABASE_URL (schema owner) when set, otherwise DATABASE_URL.
 * Login role passwords are applied when provided: DB_RUNTIME_PASSWORD (documind_runtime),
 * DB_API_PASSWORD (documind_api, migration 012) and DB_WORKER_PASSWORD (documind_worker, 013).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const MIGRATION_LOCK_KEY = 742014; // arbitrary constant shared by all runners

function log(message, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), service: 'documind-migrate', message, ...extra }));
}

async function setRolePassword(client, role, password) {
  // ALTER ROLE cannot take bind parameters; format(%L) quotes the literal server-side.
  const { rows } = await client.query('SELECT format($1, $2::text) AS sql', [`ALTER ROLE ${role} WITH LOGIN PASSWORD %L`, password]);
  await client.query(rows[0].sql);
}

async function runMigrations() {
  const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  let exitCode = 0;

  try {
    log('Starting database migrations');
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows: appliedRows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(appliedRows.map(r => [r.filename, r.checksum]));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    let appliedCount = 0;

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied (checksum mismatch). Create a new migration instead.`);
        }
        continue;
      }

      const started = Date.now();
      log('Applying migration', { file });
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${err.message}`);
      }
      appliedCount += 1;
      log('Applied migration', { file, durationMs: Date.now() - started });
    }

    // The migration ledger is not application data.
    await client.query('REVOKE ALL ON schema_migrations FROM PUBLIC');
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'documind_app') THEN REVOKE ALL ON schema_migrations FROM documind_app; END IF;
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'documind_runtime') THEN REVOKE ALL ON schema_migrations FROM documind_runtime; END IF;
    END $$`);

    if (process.env.DB_RUNTIME_PASSWORD) {
      await setRolePassword(client, 'documind_runtime', process.env.DB_RUNTIME_PASSWORD);
      log('Runtime role password applied', { role: 'documind_runtime' });
    }
    // Least-privilege logins (NOBYPASSRLS). Created by 012/013 with no password (unusable)
    // until one is applied here.
    for (const [role, variable] of [['documind_api', 'DB_API_PASSWORD'], ['documind_worker', 'DB_WORKER_PASSWORD']]) {
      if (process.env[variable]) {
        await setRolePassword(client, role, process.env[variable]);
        log('Login role password applied', { role });
      }
    }
    if (process.env.NODE_ENV === 'production') {
      // documind_app is only a SET ROLE target; its development password must not grant logins.
      await client.query('ALTER ROLE documind_app NOLOGIN');
      log('documind_app login disabled (production)');
    }

    log('Migrations complete', { applied: appliedCount, total: files.length });

    // Verify RLS is still enabled + forced on every tenant table.
    const { rows: rls } = await client.query(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname`);
    log('RLS verification', { tables: rls });
    const weak = rls.filter(r => !r.forced || r.policies === 0);
    if (weak.length > 0) {
      throw new Error(`RLS verification failed for: ${weak.map(r => r.table).join(', ')}`);
    }
  } catch (err) {
    console.error(JSON.stringify({ time: new Date().toISOString(), service: 'documind-migrate', level: 'error', message: 'Migration failed', error: err.message }));
    exitCode = 1;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
  if (exitCode) process.exit(exitCode);
}

if (require.main === module) {
  runMigrations();
}

module.exports = runMigrations;
