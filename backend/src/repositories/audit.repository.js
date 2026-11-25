const { pool } = require('../db');

class AuditRepository {
  /** `db` may be a transaction client so the entry commits or rolls back with the change it records. */
  async log({ organizationId, actorId, action, resourceId, metadata }, db = pool) {
    await db.query(
      'INSERT INTO audit_logs (organization_id, actor_id, action, resource_id, metadata) VALUES ($1, $2, $3, $4, $5)',
      [organizationId, actorId, action, resourceId, metadata]
    );
  }
}

module.exports = new AuditRepository();
