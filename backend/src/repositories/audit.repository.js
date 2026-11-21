const { pool } = require('../db');

class AuditRepository {
  async log({ organizationId, actorId, action, resourceId, metadata }) {
    await pool.query(
      'INSERT INTO audit_logs (organization_id, actor_id, action, resource_id, metadata) VALUES ($1, $2, $3, $4, $5)',
      [organizationId, actorId, action, resourceId, metadata]
    );
  }
}

module.exports = new AuditRepository();
