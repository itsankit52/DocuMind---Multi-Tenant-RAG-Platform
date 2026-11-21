const { pool } = require('./index');
const env = require('../config/env');
const { metrics, safe } = require('../observability/metrics');

/**
 * Executes a block of database operations within a transaction,
 * setting the tenant context for RLS.
 *
 * @param {string} tenantId - The organization ID to set as the tenant context.
 * @param {function} callback - Async function containing the DB operations.
 * @returns {Promise<any>} - Result of the callback.
 */
async function withTenantTransaction(tenantId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure we run under the non-superuser application role so RLS is strictly enforced
    await client.query('SET LOCAL ROLE documind_app');

    // Set the tenant context for this transaction
    // Passing true as 3rd parameter makes it transaction-local (equivalent to SET LOCAL).
    await client.query('SELECT set_config($1, $2, true)', [env.PG_TENANT_SETTING, tenantId]);

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    safe(() => metrics.dbTransactionErrors.inc());
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  withTenantTransaction,
};
