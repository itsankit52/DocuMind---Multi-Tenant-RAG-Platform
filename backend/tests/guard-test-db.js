/**
 * Jest globalSetup: the backend suites TRUNCATE organizations, users, documents, ... on
 * whatever DATABASE_URL points to. Refuse to run unless it names a dedicated *_test
 * database, so `npm test` can never wipe a development or production database.
 *
 * Redis: the suites also create, overwrite and delete `ratelimit:*` counters. REDIS_URL must
 * be passed EXPLICITLY (not inherited from .env, which points at development) and must
 * select a dedicated, non-zero logical database, e.g. redis://127.0.0.1:6380/15.
 * There is no fallback: without it the run is refused.
 */
const fs = require('fs');
const path = require('path');

// Captured before dotenv runs: dotenv would silently fill REDIS_URL from .env (development).
const EXPLICIT_REDIS_URL = process.env.REDIS_URL;

// Suites stub the embedding model per test; a cached question vector would bypass the stub.
// The cache is off unless a run sets it explicitly (its own suite enables it per test).
if (process.env.RAG_EMBEDDING_CACHE_TTL_SECONDS === undefined) process.env.RAG_EMBEDDING_CACHE_TTL_SECONDS = '0';

require('dotenv').config({ quiet: true });

const TEST_COMMAND_HINT = 'e.g. DATABASE_URL=.../documind_test REDIS_URL=redis://127.0.0.1:6380/15 npx jest --runInBand';

/** { host, port, db } of a redis:// URL, or null when it cannot be parsed. */
function redisTarget(url) {
  try {
    const u = new URL(url);
    if (!['redis:', 'rediss:'].includes(u.protocol)) return null;
    const dbPath = u.pathname.replace(/^\//, '');
    if (dbPath !== '' && !/^\d+$/.test(dbPath)) return null;
    return { host: u.hostname.toLowerCase(), port: u.port || '6379', db: dbPath === '' ? 0 : Number(dbPath) };
  } catch {
    return null;
  }
}

/** The REDIS_URL configured in backend/.env (development), if any. */
function developmentRedisTarget() {
  try {
    const parsed = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
    return parsed.REDIS_URL ? redisTarget(parsed.REDIS_URL) : null;
  } catch {
    return null;
  }
}

/** No default parameters: a missing URL must be reported as missing, never replaced. */
function assertTestRedis(explicitUrl, devTarget) {
  if (!explicitUrl) {
    throw new Error(
      'Refusing to run backend tests without an explicit REDIS_URL: .env points at the development ' +
      `Redis and the suites delete rate-limit keys. Use a dedicated logical database (${TEST_COMMAND_HINT}).`,
    );
  }
  const target = redisTarget(explicitUrl);
  if (!target) {
    throw new Error('Refusing to run backend tests: REDIS_URL is not a valid redis:// URL with a numeric database.');
  }
  if (target.db === 0) {
    throw new Error(
      'Refusing to run backend tests against Redis database 0 (the default/development database). ' +
      `Select a dedicated test database (${TEST_COMMAND_HINT}).`,
    );
  }
  if (devTarget && devTarget.host === target.host && devTarget.port === target.port && devTarget.db === target.db) {
    throw new Error(`Refusing to run backend tests: REDIS_URL selects the development Redis database ${target.db} from .env.`);
  }
  return target;
}

module.exports = async () => {
  const url = process.env.DATABASE_URL || '';
  let dbName = '';
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    // fall through to the refusal below
  }
  if (!/_test$/.test(dbName) || process.env.NODE_ENV === 'production') {
    throw new Error(
      `Refusing to run backend tests against database "${dbName || '(unparseable DATABASE_URL)'}". ` +
      'The suites TRUNCATE tables: point DATABASE_URL at a dedicated *_test database ' +
      '(e.g. createdb documind_test && DATABASE_URL=.../documind_test node migrate.js).',
    );
  }
  assertTestRedis(EXPLICIT_REDIS_URL, developmentRedisTarget());
};

module.exports.assertTestRedis = assertTestRedis;
module.exports.redisTarget = redisTarget;
