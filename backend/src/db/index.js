const { Pool } = require('pg');
const env = require('../config/env');
const { metrics, safe, secondsSince } = require('../observability/metrics');
const logger = require('../observability/logger');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});

// Low-cardinality operation label derived from the leading SQL keyword (never the SQL text).
const OPERATIONS = ['select', 'insert', 'update', 'delete', 'begin', 'commit', 'rollback', 'set', 'with'];
function sqlOperation(queryArg) {
  const text = typeof queryArg === 'string' ? queryArg : queryArg && queryArg.text;
  const match = /^\s*([a-z]+)/i.exec(text || '');
  const keyword = match ? match[1].toLowerCase() : '';
  return OPERATIONS.includes(keyword) ? keyword : 'other';
}

/**
 * Wrap a query function so promise-style calls are timed / error-counted.
 * Callback-style calls pass through untouched — pool.query itself uses client.query with a
 * callback internally, so each query is observed exactly once.
 */
function observeQuery(originalQuery) {
  return function observedQuery(...args) {
    const start = process.hrtime.bigint();
    const result = originalQuery.apply(this, args);
    if (!result || typeof result.then !== 'function') return result;
    const operation = sqlOperation(args[0]);
    return result.then(
      (value) => {
        safe(() => metrics.dbQueryDuration.observe({ operation }, secondsSince(start)));
        return value;
      },
      (err) => {
        safe(() => {
          metrics.dbQueryDuration.observe({ operation }, secondsSince(start));
          metrics.dbQueryErrors.inc({ operation });
        });
        throw err;
      },
    );
  };
}

// pool.query(...) and queries on checked-out clients (transactions)
pool.query = observeQuery(pool.query);
pool.on('connect', (client) => {
  client.query = observeQuery(client.query);
});

// Idle-client errors (e.g. server restart) must not crash the process.
pool.on('error', (err) => {
  safe(() => metrics.dbQueryErrors.inc({ operation: 'connection' }));
  logger.error('PostgreSQL idle client error', { error: err });
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  sqlOperation,
};
