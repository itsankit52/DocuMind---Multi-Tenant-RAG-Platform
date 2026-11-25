const { pool } = require('../db');
const AppError = require('../utils/AppError');
const auditRepo = require('./audit.repository');

class OrgRepository {
  constructor() {
    // Max wait for the per-organization membership lock (setMemberRole). Tests may lower it.
    this.memberLockTimeoutMs = 5000;
  }

  async create({ name, slug, ownerId }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [org] } = await client.query(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        [name, slug]
      );

      await client.query(
        'INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [org.id, ownerId, 'admin']
      );

      // Same transaction: an organization never exists without its ORG_CREATE audit entry.
      await auditRepo.log({
        organizationId: org.id,
        actorId: ownerId,
        action: 'ORG_CREATE',
        resourceId: org.id,
        metadata: { name, slug },
      }, client);

      await client.query('COMMIT');
      return org;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findMembershipsByUser(userId) {
    const { rows } = await pool.query(
      `SELECT m.organization_id, o.name, o.slug, m.role
       FROM memberships m
       JOIN organizations o ON m.organization_id = o.id
       WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'`,
      [userId]
    );
    return rows;
  }

  async validateMembership(userId, organizationId) {
    const { rows } = await pool.query(
      `SELECT m.role
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active' AND o.status = 'active'`,
      [userId, organizationId]
    );
    return rows[0];
  }

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT id, name, slug, status, created_at FROM organizations WHERE id = $1',
      [id]
    );
    return rows[0];
  }

  async findBySlug(slug) {
    const { rows } = await pool.query(
      'SELECT id, name, slug, status, created_at FROM organizations WHERE slug = $1',
      [slug]
    );
    return rows[0];
  }

  /**
   * Add a member or change a member's role, serialized per organization so concurrent
   * requests can never leave an active organization without an active admin.
   * This is the only writer of existing organizations' memberships: any new membership
   * write path (e.g. invitation acceptance) must take the same organization lock.
   *
   * The organization row is locked FOR NO KEY UPDATE: concurrent role changes in the same
   * organization queue behind each other, while FK checks from tenant inserts (documents,
   * messages, ... take FOR KEY SHARE) are not blocked. The transaction is explicitly
   * READ COMMITTED: each statement after the lock takes a fresh snapshot, so the actor's
   * admin role and the admin count are re-checked against the previous holder's committed
   * result (under REPEATABLE READ they could be read from a stale snapshot).
   * lock_timeout bounds the wait so a stuck holder cannot pin pool connections indefinitely.
   */
  async setMemberRole({ organizationId, actorId, userId, role }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.memberLockTimeoutMs}ms`]);

      const { rows: [org] } = await client.query(
        'SELECT status FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
        [organizationId]
      );
      const { rows: [actor] } = await client.query(
        `SELECT role FROM memberships
         WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
        [organizationId, actorId]
      );
      // The actor may have been demoted by a request that held the lock before us.
      if (!org || org.status !== 'active' || !actor || actor.role !== 'admin') {
        throw new AppError('Admin privileges required for this organization.', 403);
      }

      const { rows: [current] } = await client.query(
        `SELECT role FROM memberships
         WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
        [organizationId, userId]
      );
      if (current && current.role === 'admin' && role !== 'admin') {
        const { rows: [{ n }] } = await client.query(
          `SELECT count(*)::int AS n FROM memberships
           WHERE organization_id = $1 AND role = 'admin' AND status = 'active'`,
          [organizationId]
        );
        if (n <= 1) {
          throw new AppError('An organization must keep at least one admin. Promote another member to admin first.', 409);
        }
      }

      const { rows: [membership] } = await client.query(
        `INSERT INTO memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, status = 'active'
         RETURNING *`,
        [organizationId, userId, role.toLowerCase()]
      );

      await client.query('COMMIT');
      return membership;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && error.code === '55P03') { // lock_not_available: lock_timeout expired
        throw new AppError('Another membership change for this organization is in progress. Please retry.', 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listMembers(organizationId) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.full_name, m.role, m.status, m.created_at
       FROM memberships m
       JOIN users u ON m.user_id = u.id
       WHERE m.organization_id = $1 AND m.status = 'active'
       ORDER BY m.created_at ASC`,
      [organizationId]
    );
    return rows;
  }

  async countActiveAdmins(organizationId) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM memberships
       WHERE organization_id = $1 AND role = 'admin' AND status = 'active'`,
      [organizationId]
    );
    return rows[0].n;
  }

}

module.exports = new OrgRepository();
