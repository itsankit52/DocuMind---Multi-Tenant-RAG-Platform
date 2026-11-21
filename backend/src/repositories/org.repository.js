const { pool } = require('../db');
const AppError = require('../utils/AppError');

class OrgRepository {
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

  async addMember(organizationId, userId, role = 'member') {
    const { rows } = await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, status = 'active'
       RETURNING *`,
      [organizationId, userId, role.toLowerCase()]
    );
    return rows[0];
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

  async updateRole(organizationId, userId, newRole) {
    const { rows } = await pool.query(
      'UPDATE memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3 RETURNING *',
      [newRole.toLowerCase(), organizationId, userId]
    );
    return rows[0];
  }
}

module.exports = new OrgRepository();
