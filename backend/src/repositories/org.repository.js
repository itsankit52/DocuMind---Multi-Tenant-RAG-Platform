const { pool } = require('../db');
const env = require('../config/env');
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
      // audit_logs is RLS-protected: write it as documind_app in the new organization's tenant
      // context (transaction-local), not through the login role's BYPASSRLS (Phase 3.3 / F2).
      await client.query('SET LOCAL ROLE documind_app');
      await client.query('SELECT set_config($1, $2, true)', [env.PG_TENANT_SETTING, org.id]);
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
  /**
   * Take the per-organization lock and re-check, against current data, that the organization
   * is active and the actor is an active admin. Must be the FIRST lock taken by any
   * transaction that changes memberships or invitations (lock order: organization row →
   * invitation/membership rows), so those transactions serialize without deadlocks.
   * Sets a transaction-local lock_timeout; a timeout surfaces as SQLSTATE 55P03
   * (see toLockTimeoutError). Works on any client: a plain transaction (runtime role) or a
   * withTenantTransaction client (documind_app; organizations/memberships have no RLS).
   */
  async lockOrganizationAsAdmin(client, organizationId, actorId) {
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
    // The actor may have been demoted (or the organization suspended) by a request that
    // held the lock before us.
    if (!org || org.status !== 'active' || !actor || actor.role !== 'admin') {
      throw new AppError('Admin privileges required for this organization.', 403);
    }
  }

  /** Map an expired lock_timeout (SQLSTATE 55P03) to the API's retryable 409; otherwise null. */
  toLockTimeoutError(error) {
    if (error && error.code === '55P03') {
      return new AppError('Another change to this organization is in progress. Please retry.', 409);
    }
    return null;
  }

  /**
   * Invitation acceptance (the invitee is not a member, so lockOrganizationAsAdmin does not
   * apply). Takes the SAME per-organization lock, first, with the same lock_timeout, and
   * reports whether the organization is active. Grants nothing by itself: the caller must
   * still validate the invitation, the inviter and the invitee under this lock.
   */
  async lockOrganizationForInvitationAcceptance(client, organizationId) {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.memberLockTimeoutMs}ms`]);
    const { rows: [org] } = await client.query(
      'SELECT name, status FROM organizations WHERE id = $1 FOR NO KEY UPDATE',
      [organizationId]
    );
    return org && org.status === 'active' ? { name: org.name } : null;
  }

  /** Name of the organization if it is active (no lock: read-only preview). */
  async findActiveOrganization(db, organizationId) {
    const { rows } = await db.query(
      "SELECT name FROM organizations WHERE id = $1 AND status = 'active'",
      [organizationId]
    );
    return rows[0];
  }

  /**
   * The user, if they are currently an active admin of the organization and an active account.
   * `lockShared` (invitation acceptance, F7): FOR SHARE OF m, u holds the inviter's membership
   * and user rows until COMMIT, so a writer that bypasses the organization lock (manual SQL)
   * cannot demote or disable the inviter mid-acceptance; one that got there first is waited
   * for, and the WHERE is re-checked on the committed row (READ COMMITTED). FOR SHARE is the
   * weakest mode that conflicts with a non-key UPDATE (FOR NO KEY UPDATE); FOR KEY SHARE would not.
   */
  async findActiveAdmin(db, organizationId, userId, { lockShared = false } = {}) {
    const { rows } = await db.query(
      `SELECT u.full_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.user_id = $2
         AND m.status = 'active' AND m.role = 'admin' AND u.status = 'active'
       ${lockShared ? 'FOR SHARE OF m, u' : ''}`,
      [organizationId, userId]
    );
    return rows[0];
  }

  /** Lock this user's membership row in the organization, if any (after the organization lock). */
  async findMembershipForUpdate(client, organizationId, userId) {
    const { rows } = await client.query(
      `SELECT id, role, status FROM memberships
       WHERE organization_id = $1 AND user_id = $2
       FOR UPDATE`,
      [organizationId, userId]
    );
    return rows[0];
  }

  /**
   * Create an active membership, or reactivate a non-active one (removed / invited), with the
   * given role. An ACTIVE membership is never modified: the conditional DO UPDATE then affects
   * no row and undefined is returned, so acceptance can never change an existing member's role.
   * The existing row (id, created_at) is kept on reactivation; there is no duplicate.
   */
  async activateMembershipFromInvitation(client, { organizationId, userId, role }) {
    const { rows } = await client.query(
      `INSERT INTO memberships (organization_id, user_id, role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (organization_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, status = 'active'
       WHERE memberships.status <> 'active'
       RETURNING id, role, status, created_at, (xmax = 0) AS inserted`,
      [organizationId, userId, role]
    );
    return rows[0];
  }

  async setMemberRole({ organizationId, actorId, userId, role }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await this.lockOrganizationAsAdmin(client, organizationId, actorId);

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
      throw this.toLockTimeoutError(error) || error;
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
