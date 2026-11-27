const express = require('express');
const zod = require('zod');
const { pool } = require('../db');
const orgRepo = require('../repositories/org.repository');
const userRepo = require('../repositories/user.repository');
const auditRepo = require('../repositories/audit.repository');
const invitationService = require('../invitations/invitation.service');
const { checkRole } = require('../middleware/rbac');
const rateLimiter = require('../middleware/rate-limiter');
const { UUID_RE } = require('../middleware/tenant');
const AppError = require('../utils/AppError');

const router = express.Router();

// Mounted behind authMiddleware, so budgets are per user (not per IP behind a shared NAT).
const orgRateLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `ratelimit:org:${req.user.id}`,
});

// Tighter budget for state-changing requests (organization creation, member/role changes).
const orgWriteRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `ratelimit:org-write:${req.user.id}`,
});

// Invitation creation/resend issue new tokens: an extra budget per admin per organization.
// The UUID is lowercased so case variants of the same organization share one budget.
const invitationSendRateLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `ratelimit:org-invite:${req.user.id}:${String(req.params.organizationId).toLowerCase()}`,
});

router.use(orgRateLimiter);

// Reject malformed IDs before they reach PostgreSQL (a uuid cast error would surface as 500).
router.param('organizationId', (req, res, next, organizationId) => {
  if (!UUID_RE.test(organizationId)) {
    return next(new AppError('Organization ID must be a valid UUID.', 400));
  }
  next();
});

router.param('invitationId', (req, res, next, invitationId) => {
  if (!UUID_RE.test(invitationId)) {
    return next(new AppError('Invitation ID must be a valid UUID.', 400));
  }
  next();
});

const createOrgSchema = zod.object({
  name: zod.string().min(2, 'Organization name must be at least 2 characters'),
  slug: zod.string().min(2, 'Slug must be at least 2 characters').regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase alphanumeric characters and hyphens'),
});

const addMemberSchema = zod.object({
  email: zod.string().email('Valid email is required'),
  role: zod.enum(['admin', 'member', 'viewer']).default('member'),
});

const INVITATION_ROLES = ['admin', 'member', 'viewer'];
const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'];

// Normalized before validation: stored exactly as the migration-010 CHECK requires.
const createInvitationSchema = zod.object({
  email: zod.string('Valid email is required')
    .trim()
    .toLowerCase()
    .max(254, 'Email must be at most 254 characters')
    .email('Valid email is required'),
  role: zod.enum(INVITATION_ROLES, { message: `Role must be one of: ${INVITATION_ROLES.join(', ')}` }),
});

const listInvitationsSchema = zod.object({
  page: zod.coerce.number().int('page must be an integer').min(1, 'page must be at least 1').max(10000, 'page is too large').default(1),
  limit: zod.coerce.number().int('limit must be an integer').min(1, 'limit must be at least 1').max(100, 'limit must be at most 100').default(20),
  status: zod.enum(INVITATION_STATUSES, { message: `status must be one of: ${INVITATION_STATUSES.join(', ')}` }).optional(),
});

/** Responses carrying a raw invitation token must never be cached. */
const noStore = (res) => res.set('Cache-Control', 'no-store');

// Create Organization
router.post('/', orgWriteRateLimiter, async (req, res, next) => {
  try {
    const parseResult = createOrgSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(AppError.fromZod(parseResult.error));
    }

    const { name, slug } = parseResult.data;

    const existing = await orgRepo.findBySlug(slug);
    if (existing) {
      return next(new AppError('Organization with this slug already exists.', 400));
    }

    // Creates the organization, the creator's admin membership and the ORG_CREATE audit entry atomically
    const org = await orgRepo.create({ name, slug, ownerId: req.user.id });

    res.status(201).json({ status: 'success', data: { org } });
  } catch (err) {
    next(AppError.from(err));
  }
});

// Get my organizations
router.get('/my-organizations', async (req, res, next) => {
  try {
    const orgs = await orgRepo.findMembershipsByUser(req.user.id);
    res.status(200).json({ status: 'success', data: { organizations: orgs } });
  } catch (err) {
    next(AppError.from(err));
  }
});

// Select active organization (Validation endpoint)
router.post('/:organizationId/select', async (req, res, next) => {
  try {
    const { organizationId } = req.params;
    const membership = await orgRepo.validateMembership(req.user.id, organizationId);

    if (!membership) {
      return next(new AppError('You do not belong to this organization.', 403));
    }

    res.status(200).json({
      status: 'success',
      message: 'Organization selected successfully',
      data: {
        organizationId,
        role: membership.role,
      },
    });
  } catch (err) {
    next(AppError.from(err));
  }
});

// Middleware to verify that the user has admin role in the target organization
async function requireOrgAdmin(req, res, next) {
  const { organizationId } = req.params;
  let membership;
  try {
    membership = await orgRepo.validateMembership(req.user.id, organizationId);
  } catch (err) {
    return next(AppError.from(err));
  }

  if (!membership || membership.role !== 'admin') {
    return next(new AppError('Admin privileges required for this organization.', 403));
  }

  res.locals.tenantId = organizationId;
  res.locals.userRole = membership.role;
  next();
}

// Get members of organization (Admin only)
router.get('/:organizationId/members', requireOrgAdmin, async (req, res, next) => {
  try {
    const { organizationId } = req.params;
    const members = await orgRepo.listMembers(organizationId);
    res.status(200).json({ status: 'success', data: { members } });
  } catch (err) {
    next(AppError.from(err));
  }
});

// Add member to organization (Admin only)
router.post('/:organizationId/members', orgWriteRateLimiter, requireOrgAdmin, async (req, res, next) => {
  try {
    const { organizationId } = req.params;
    const parseResult = addMemberSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(AppError.fromZod(parseResult.error));
    }

    const { email, role } = parseResult.data;
    const user = await userRepo.findByEmail(email);

    if (!user) {
      return next(new AppError(`User with email ${email} not found. They must register first.`, 404));
    }

    // This endpoint also changes an existing member's role (upsert). It never demotes the
    // organization's last active admin (409) — checked under a per-organization lock so
    // concurrent demotions cannot race past each other.
    const membership = await orgRepo.setMemberRole({
      organizationId,
      actorId: req.user.id,
      userId: user.id,
      role,
    });

    await auditRepo.log({
      organizationId,
      actorId: req.user.id,
      action: 'MEMBER_ADD',
      resourceId: user.id,
      metadata: { email, role },
    });

    res.status(201).json({ status: 'success', data: { membership } });
  } catch (err) {
    next(AppError.from(err));
  }
});

// ─── Invitations (Admin only) ────────────────────────────────────────────────

// Create invitation: returns the raw token (once) and, if APP_BASE_URL is set, the invite URL
router.post('/:organizationId/invitations', orgWriteRateLimiter, invitationSendRateLimiter, requireOrgAdmin, async (req, res, next) => {
  try {
    const parseResult = createInvitationSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(AppError.fromZod(parseResult.error));
    }
    const result = await invitationService.createInvitation({
      organizationId: req.params.organizationId,
      actorId: req.user.id,
      ...parseResult.data,
    });
    noStore(res).status(201).json({ status: 'success', data: result });
  } catch (err) {
    next(AppError.from(err));
  }
});

// List invitations (paginated, optional effective-status filter; never includes tokens)
router.get('/:organizationId/invitations', requireOrgAdmin, async (req, res, next) => {
  try {
    const parseResult = listInvitationsSchema.safeParse(req.query);
    if (!parseResult.success) {
      return next(AppError.fromZod(parseResult.error));
    }
    const result = await invitationService.listInvitations({
      organizationId: req.params.organizationId,
      ...parseResult.data,
    });
    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(AppError.from(err));
  }
});

// Revoke a pending invitation
router.delete('/:organizationId/invitations/:invitationId', orgWriteRateLimiter, requireOrgAdmin, async (req, res, next) => {
  try {
    const result = await invitationService.revokeInvitation({
      organizationId: req.params.organizationId,
      actorId: req.user.id,
      invitationId: req.params.invitationId,
    });
    res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(AppError.from(err));
  }
});

// Resend: new token (the previous one stops working) and a fresh 72-hour expiry
router.post('/:organizationId/invitations/:invitationId/resend', orgWriteRateLimiter, invitationSendRateLimiter, requireOrgAdmin, async (req, res, next) => {
  try {
    const result = await invitationService.resendInvitation({
      organizationId: req.params.organizationId,
      actorId: req.user.id,
      invitationId: req.params.invitationId,
    });
    noStore(res).status(200).json({ status: 'success', data: result });
  } catch (err) {
    next(AppError.from(err));
  }
});

module.exports = router;

