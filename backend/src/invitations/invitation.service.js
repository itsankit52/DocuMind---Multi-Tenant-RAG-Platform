/**
 * Admin invitation management (Phase 2): create, list, revoke, resend.
 *
 * Every mutation runs in ONE withTenantTransaction() (documind_app, RLS enforced, tenant =
 * the organization) that:
 *   1. takes the per-organization lock and re-checks "active organization + actor is an
 *      active admin" against current data (orgRepo.lockOrganizationAsAdmin — the same lock
 *      and order as setMemberRole: organization row → invitation rows);
 *   2. performs the invitation change;
 *   3. writes the audit entry on the same client, so it commits or rolls back with it.
 *
 * Tokens: 32 random bytes, base64url. Only SHA-256(token) is stored. The raw token is
 * returned once (create / resend response) and never logged, audited or persisted.
 */

const crypto = require('crypto');
const env = require('../config/env');
const { pool } = require('../db');
const { withTenantTransaction } = require('../db/transaction');
const orgRepo = require('../repositories/org.repository');
const userRepo = require('../repositories/user.repository');
const invitationRepo = require('../repositories/invitation.repository');
const auditRepo = require('../repositories/audit.repository');
const AppError = require('../utils/AppError');

const INVITATION_TTL_HOURS = 72;

const ERRORS = {
  notFound: () => new AppError('Invitation not found.', 404),
  pendingExists: () => new AppError('A pending invitation already exists for this email address.', 409),
  accepted: () => new AppError('This invitation has already been accepted.', 409),
  revoked: () => new AppError('This invitation has been revoked.', 409),
  expired: () => new AppError('This invitation has expired.', 409),
  // Invitee-facing: one generic answer for every invalid case (unknown token, not pending,
  // expired, organization inactive, inviter no longer an active admin, email mismatch).
  invalid: () => new AppError('Invitation not found or no longer valid.', 404),
  alreadyMember: () => new AppError('You are already a member of this organization.', 409, 'ALREADY_ORGANIZATION_MEMBER'),
};

function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateInvitationToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

/** `${APP_BASE_URL}/invite#token=…` — the token travels in the fragment, never to servers. */
function buildInviteUrl(token) {
  if (!env.APP_BASE_URL) return null;
  return `${env.APP_BASE_URL.replace(/\/$/, '')}/invite#token=${token}`;
}

function mapDatabaseError(err) {
  const lockTimeout = orgRepo.toLockTimeoutError(err);
  if (lockTimeout) return lockTimeout;
  // Defensive: the organization lock serializes these writers, so the indexes should not trip.
  if (err && err.code === '23505' && err.constraint === 'uidx_org_invitations_pending_email') {
    return ERRORS.pendingExists();
  }
  if (err && err.code === '23505' && err.constraint === 'memberships_organization_id_user_id_key') {
    return ERRORS.alreadyMember();
  }
  return err;
}

/**
 * Run `work(client)` in one tenant transaction for `organizationId` (documind_app, RLS).
 * If `work` RETURNS an AppError, the transaction still commits (e.g. an expiry transition)
 * and the error is thrown afterwards; a THROWN error rolls everything back.
 */
async function invitationTransaction(organizationId, work) {
  let result;
  try {
    result = await withTenantTransaction(organizationId, async (client) => {
      // The re-checks after the lock rely on READ COMMITTED (fresh snapshot per statement).
      const { rows: [{ level }] } = await client.query("SELECT current_setting('transaction_isolation') AS level");
      if (level !== 'read committed') {
        throw new Error(`Invitation transactions require READ COMMITTED isolation (got ${level})`);
      }
      return work(client);
    });
  } catch (err) {
    throw mapDatabaseError(err);
  }
  if (result instanceof AppError) throw result;
  return result;
}

/** An organization admin mutation: organization lock + admin re-check first (see header). */
function adminMutation(organizationId, actorId, work) {
  return invitationTransaction(organizationId, async (client) => {
    await orgRepo.lockOrganizationAsAdmin(client, organizationId, actorId);
    return work(client);
  });
}

/**
 * Lock the invitation and require it to be pending and unexpired. A pending invitation past
 * expires_at is transitioned to 'expired' (committed) and reported as expired — never revived.
 * Returns an AppError for the caller to return, or null when the invitation is usable.
 */
async function lockPendingInvitation(client, { organizationId, invitationId }) {
  const current = await invitationRepo.findForUpdate(client, { organizationId, invitationId });
  if (!current) return ERRORS.notFound();
  if (current.status === 'accepted') return ERRORS.accepted();
  if (current.status === 'revoked') return ERRORS.revoked();
  if (current.status === 'expired') return ERRORS.expired();
  if (current.is_expired) {
    await invitationRepo.markExpired(client, { organizationId, invitationId });
    return ERRORS.expired();
  }
  return null;
}

async function createInvitation({ organizationId, actorId, email, role }) {
  const { token, tokenHash } = generateInvitationToken();

  const invitation = await adminMutation(organizationId, actorId, async (client) => {
    await invitationRepo.expireStalePendingByEmail(client, { organizationId, email });
    if (await invitationRepo.findPendingByEmail(client, { organizationId, email })) {
      throw ERRORS.pendingExists();
    }

    const created = await invitationRepo.create(client, {
      organizationId, email, role, tokenHash, invitedBy: actorId, ttlHours: INVITATION_TTL_HOURS,
    });
    await auditRepo.log({
      organizationId,
      actorId,
      action: 'INVITATION_CREATE',
      resourceId: created.id,
      metadata: { invitationId: created.id, email, role, expiresAt: created.expires_at },
    }, client);
    return created;
  });

  return { invitation, token, inviteUrl: buildInviteUrl(token) };
}

async function listInvitations({ organizationId, status, page, limit }) {
  const { invitations, totalCount } = await withTenantTransaction(organizationId, (client) =>
    invitationRepo.listByOrganization(client, { organizationId, status, page, limit }));
  return {
    invitations,
    pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
  };
}

async function revokeInvitation({ organizationId, actorId, invitationId }) {
  const invitation = await adminMutation(organizationId, actorId, async (client) => {
    const unusable = await lockPendingInvitation(client, { organizationId, invitationId });
    if (unusable) return unusable;

    const revoked = await invitationRepo.revoke(client, { organizationId, invitationId, revokedBy: actorId });
    await auditRepo.log({
      organizationId,
      actorId,
      action: 'INVITATION_REVOKE',
      resourceId: invitationId,
      metadata: { invitationId, email: revoked.email, role: revoked.role },
    }, client);
    return revoked;
  });
  return { invitation };
}

async function resendInvitation({ organizationId, actorId, invitationId }) {
  const { token, tokenHash } = generateInvitationToken();

  const invitation = await adminMutation(organizationId, actorId, async (client) => {
    const unusable = await lockPendingInvitation(client, { organizationId, invitationId });
    if (unusable) return unusable;

    const resent = await invitationRepo.rotateToken(client, {
      organizationId, invitationId, tokenHash, ttlHours: INVITATION_TTL_HOURS,
    });
    await auditRepo.log({
      organizationId,
      actorId,
      action: 'INVITATION_RESEND',
      resourceId: invitationId,
      metadata: { invitationId, email: resent.email, role: resent.role, expiresAt: resent.expires_at },
    }, client);
    return resent;
  });

  return { invitation, token, inviteUrl: buildInviteUrl(token) };
}

// ─── Invitee-facing: preview and acceptance (Phase 3) ──────────────────────────
//
// Lock order for acceptance (same as every membership/invitation writer):
//   organization row (FOR NO KEY UPDATE) → invitation row (FOR UPDATE)
//   → inviter membership + user rows (FOR SHARE, F7) → invitee membership row (FOR UPDATE)
// All validation is repeated under those locks; a preview result never authorizes anything.

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/**
 * Validate an invitation for `userId` inside the tenant transaction. Returns
 * { inviter } when usable, or the generic invalid AppError. With `transitionExpired`
 * (acceptance only), an overdue pending invitation is moved to 'expired' (committed).
 */
async function checkInvitationUsable(client, { organizationId, invitation, userId, transitionExpired }) {
  if (!invitation || invitation.status !== 'pending') return ERRORS.invalid();
  if (invitation.is_expired) {
    if (transitionExpired) await invitationRepo.markExpired(client, { organizationId, invitationId: invitation.id });
    return ERRORS.invalid();
  }
  // Acceptance (transitionExpired) also share-locks the inviter's membership and user rows
  // (lock step 3, before the invitee's membership); preview stays lock-free.
  const inviter = invitation.invited_by
    ? await orgRepo.findActiveAdmin(client, organizationId, invitation.invited_by, { lockShared: transitionExpired })
    : null;
  if (!inviter) return ERRORS.invalid();

  // Re-read the invitee in this transaction; compare trimmed, case-insensitively.
  const user = await userRepo.findById(userId, client);
  if (!user || user.status !== 'active' || normalizeEmail(user.email) !== invitation.email) {
    return ERRORS.invalid();
  }
  return { inviter };
}

/** Resolve the organization of a token (runtime lookup, see the repository) or fail generically. */
async function resolveTokenOrganization(tokenHash) {
  const organizationId = await invitationRepo.findOrganizationIdByTokenHash(pool, tokenHash);
  if (!organizationId) throw ERRORS.invalid();
  return organizationId;
}

/** Read-only: never locks, never writes, never creates a membership. */
async function previewInvitation({ token, userId }) {
  const tokenHash = hashInvitationToken(token);
  const organizationId = await resolveTokenOrganization(tokenHash);

  return invitationTransaction(organizationId, async (client) => {
    const org = await orgRepo.findActiveOrganization(client, organizationId);
    if (!org) return ERRORS.invalid();
    const invitation = await invitationRepo.findByTokenHash(client, { organizationId, tokenHash });
    const usable = await checkInvitationUsable(client, { organizationId, invitation, userId, transitionExpired: false });
    if (usable instanceof AppError) return usable;
    return {
      invitation: {
        organizationName: org.name,
        role: invitation.role,
        inviterName: usable.inviter.full_name || null,
        expiresAt: invitation.expires_at,
      },
    };
  });
}

async function acceptInvitation({ token, userId }) {
  const tokenHash = hashInvitationToken(token);
  const organizationId = await resolveTokenOrganization(tokenHash);

  return invitationTransaction(organizationId, async (client) => {
    // 1. Organization lock (no admin requirement: the invitee is not a member yet)
    const org = await orgRepo.lockOrganizationForInvitationAcceptance(client, organizationId);
    if (!org) return ERRORS.invalid();

    // 2. Invitation row lock, re-selected by token hash within this tenant (a resend that
    //    committed before we got the lock replaced the hash: the old token finds nothing)
    const invitation = await invitationRepo.findByTokenHash(client, { organizationId, tokenHash, forUpdate: true });
    const usable = await checkInvitationUsable(client, { organizationId, invitation, userId, transitionExpired: true });
    if (usable instanceof AppError) return usable;

    // 3. Membership row lock: an active member is never modified (no role change via invitation)
    const existing = await orgRepo.findMembershipForUpdate(client, organizationId, userId);
    if (existing && existing.status === 'active') return ERRORS.alreadyMember();

    // 4. Create or reactivate with the INVITATION's role (the client supplies only the token)
    const membership = await orgRepo.activateMembershipFromInvitation(client, {
      organizationId, userId, role: invitation.role,
    });
    if (!membership) throw ERRORS.alreadyMember(); // defensive: the row became active (rolls back)

    // 5. Invitation → accepted (exactly once: guarded by status = 'pending')
    const accepted = await invitationRepo.markAccepted(client, {
      organizationId, invitationId: invitation.id, acceptedBy: userId,
    });
    if (!accepted) throw new Error('Invitation changed state while locked'); // rolls back

    // 6. Audit on the same transaction
    await auditRepo.log({
      organizationId,
      actorId: userId,
      action: 'INVITATION_ACCEPT',
      resourceId: invitation.id,
      metadata: {
        invitationId: invitation.id,
        role: invitation.role,
        membershipAction: membership.inserted ? 'created' : 'reactivated',
        previousMembershipStatus: existing ? existing.status : null,
        acceptedAt: accepted.accepted_at,
      },
    }, client);

    return {
      organization: { id: organizationId, name: org.name },
      membership: { role: membership.role, status: membership.status },
    };
  });
}

module.exports = {
  INVITATION_TTL_HOURS,
  previewInvitation,
  acceptInvitation,
  hashInvitationToken,
  generateInvitationToken,
  buildInviteUrl,
  createInvitation,
  listInvitations,
  revokeInvitation,
  resendInvitation,
};
