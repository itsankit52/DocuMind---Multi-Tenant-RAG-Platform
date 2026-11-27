const { withTenantTransaction } = require('../db/transaction');

const INSERT_SQL =
  'INSERT INTO audit_logs (organization_id, actor_id, action, resource_id, metadata) VALUES ($1, $2, $3, $4, $5)';

class AuditRepository {
  /**
   * `db` should be the transaction client of the change being recorded, so the entry commits or
   * rolls back with it. Without one (fire-and-forget audits), the entry is written in its OWN
   * tenant transaction for `organizationId` (documind_app, RLS WITH CHECK) — never on the raw pool,
   * so audit writes do not depend on the login role's BYPASSRLS (Phase 3.3 / F2).
   */
  async log({ organizationId, actorId, action, resourceId, metadata }, db) {
    const params = [organizationId, actorId, action, resourceId, metadata];
    if (db) {
      await db.query(INSERT_SQL, params);
      return;
    }
    if (!organizationId) throw new Error('Audit entry requires an organizationId');
    await withTenantTransaction(organizationId, client => client.query(INSERT_SQL, params));
  }
}

module.exports = new AuditRepository();
