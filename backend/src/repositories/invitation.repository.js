/**
 * organization_invitations data access (migration 010).
 *
 * Every function takes a client from withTenantTransaction() (documind_app + tenant
 * context), so RLS applies, and every query ALSO filters by organization_id explicitly.
 * token_hash is written here but never selected back: PUBLIC_COLUMNS is the only shape
 * that leaves this module.
 */

const PUBLIC_COLUMNS = `id, organization_id, email, role, status, invited_by, accepted_by, revoked_by,
  expires_at, accepted_at, revoked_at, created_at, updated_at`;

/** Mark this email's pending invitation expired if it is past expires_at. */
async function expireStalePendingByEmail(client, { organizationId, email }) {
  const { rowCount } = await client.query(
    `UPDATE organization_invitations
     SET status = 'expired', updated_at = now()
     WHERE organization_id = $1 AND email = $2 AND status = 'pending' AND expires_at <= now()`,
    [organizationId, email],
  );
  return rowCount;
}

async function findPendingByEmail(client, { organizationId, email }) {
  const { rows } = await client.query(
    `SELECT id FROM organization_invitations
     WHERE organization_id = $1 AND email = $2 AND status = 'pending'`,
    [organizationId, email],
  );
  return rows[0];
}

async function create(client, { organizationId, email, role, tokenHash, invitedBy, ttlHours }) {
  const { rows } = await client.query(
    `INSERT INTO organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
     RETURNING ${PUBLIC_COLUMNS}`,
    [organizationId, email, role, tokenHash, invitedBy, ttlHours],
  );
  return rows[0];
}

/**
 * Page through an organization's invitations, newest first (ties broken by id).
 * `status` is the EFFECTIVE status: a pending invitation past expires_at is reported (and
 * filtered) as 'expired' even before a write transitions it. Reads never write.
 * The total is computed independently of the requested page (one statement, one snapshot),
 * so a page past the end returns no rows but still the correct totalCount.
 */
async function listByOrganization(client, { organizationId, status, page, limit }) {
  const offset = (page - 1) * limit;
  const { rows } = await client.query(
    `WITH invitations AS (
       SELECT id, organization_id, email, role,
              CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
              invited_by, accepted_by, revoked_by, expires_at, accepted_at, revoked_at, created_at, updated_at
       FROM organization_invitations
       WHERE organization_id = $1
     ),
     filtered AS (
       SELECT * FROM invitations WHERE ($2::text IS NULL OR status = $2::text)
     ),
     total AS (
       SELECT count(*) AS total_count FROM filtered
     )
     SELECT total.total_count, page_rows.*
     FROM total
     LEFT JOIN LATERAL (
       SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4
     ) page_rows ON true
     ORDER BY page_rows.created_at DESC, page_rows.id DESC`,
    [organizationId, status || null, limit, offset],
  );
  // Always exactly one row when the page is empty (total with NULL invitation columns).
  const totalCount = parseInt(rows[0].total_count, 10);
  return {
    invitations: rows
      .filter(row => row.id !== null)
      .map(({ total_count, ...invitation }) => invitation),
    totalCount,
  };
}

/** Lock one invitation of this organization (taken AFTER the organization lock). */
async function findForUpdate(client, { organizationId, invitationId }) {
  const { rows } = await client.query(
    `SELECT id, status, (expires_at <= now()) AS is_expired
     FROM organization_invitations
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [invitationId, organizationId],
  );
  return rows[0];
}

async function markExpired(client, { organizationId, invitationId }) {
  await client.query(
    `UPDATE organization_invitations SET status = 'expired', updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status = 'pending'`,
    [invitationId, organizationId],
  );
}

async function revoke(client, { organizationId, invitationId, revokedBy }) {
  const { rows } = await client.query(
    `UPDATE organization_invitations
     SET status = 'revoked', revoked_at = now(), revoked_by = $3, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status = 'pending'
     RETURNING ${PUBLIC_COLUMNS}`,
    [invitationId, organizationId, revokedBy],
  );
  return rows[0];
}

/** Replace the token (the previous hash stops matching immediately) and restart the expiry. */
async function rotateToken(client, { organizationId, invitationId, tokenHash, ttlHours }) {
  const { rows } = await client.query(
    `UPDATE organization_invitations
     SET token_hash = $3, expires_at = now() + make_interval(hours => $4), updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status = 'pending'
     RETURNING ${PUBLIC_COLUMNS}`,
    [invitationId, organizationId, tokenHash, ttlHours],
  );
  return rows[0];
}

/**
 * Pre-membership routing lookup (preview / acceptance): which organization does this token
 * hash belong to? The invitee is not a member yet, so there is no tenant to set; this is the
 * ONE invitation query that runs on the pool, via the restricted routing function below
 * (works under documind_api without BYPASSRLS, and under documind_runtime). It is an exact
 * token_hash match and returns only organization_id. Everything else — validation, locking,
 * writes — then runs inside withTenantTransaction(organization_id) under RLS, where the
 * invitation is re-selected by token_hash AND organization_id.
 */
async function findOrganizationIdByTokenHash(db, tokenHash) {
  // Phase 3.3 / F2 (migration 012): a SECURITY DEFINER function owned by a NOLOGIN role does the
  // exact-hash lookup, so the login role needs no direct access to organization_invitations
  // outside a tenant transaction (and no BYPASSRLS). It returns only organization_id or NULL.
  const { rows } = await db.query(
    'SELECT public.invitation_organization_for_token_hash($1) AS organization_id',
    [tokenHash],
  );
  return rows[0] ? rows[0].organization_id : null;
}

/** The invitation for this token within the tenant transaction (optionally locked FOR UPDATE). */
async function findByTokenHash(client, { organizationId, tokenHash, forUpdate = false }) {
  const { rows } = await client.query(
    `SELECT id, email, role, status, invited_by, expires_at, (expires_at <= now()) AS is_expired
     FROM organization_invitations
     WHERE token_hash = $1 AND organization_id = $2
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tokenHash, organizationId],
  );
  return rows[0];
}

async function markAccepted(client, { organizationId, invitationId, acceptedBy }) {
  const { rows } = await client.query(
    `UPDATE organization_invitations
     SET status = 'accepted', accepted_at = now(), accepted_by = $3, updated_at = now()
     WHERE id = $1 AND organization_id = $2 AND status = 'pending'
     RETURNING id, role, accepted_at`,
    [invitationId, organizationId, acceptedBy],
  );
  return rows[0];
}

module.exports = {
  PUBLIC_COLUMNS,
  findOrganizationIdByTokenHash,
  findByTokenHash,
  markAccepted,
  expireStalePendingByEmail,
  findPendingByEmail,
  create,
  listByOrganization,
  findForUpdate,
  markExpired,
  revoke,
  rotateToken,
};
