const orgRepo = require('../repositories/org.repository');
const AppError = require('../utils/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function tenantMiddleware(req, res, next) {
  const organizationId =
    req.headers['x-organization-id'] ||
    req.headers['x-tenant-id'] ||
    (req.body && req.body.organization_id) ||
    (req.body && req.body.organizationId);

  if (!organizationId) {
    return next(new AppError('Organization ID header (X-Organization-Id) is required for this request.', 400));
  }

  if (typeof organizationId !== 'string' || !UUID_RE.test(organizationId)) {
    return next(new AppError('Organization ID must be a valid UUID.', 400));
  }

  if (!req.user || !req.user.id) {
    return next(new AppError('User must be authenticated before resolving tenant context.', 401));
  }

  let membership;
  try {
    membership = await orgRepo.validateMembership(req.user.id, organizationId);
  } catch (err) {
    return next(AppError.from(err));
  }

  if (!membership) {
    return next(new AppError('You do not belong to this organization or have no active membership.', 403));
  }

  res.locals.tenantId = organizationId;
  res.locals.userRole = membership.role;
  req.tenantId = organizationId;
  req.userRole = membership.role;

  next();
}

module.exports = tenantMiddleware;
module.exports.UUID_RE = UUID_RE;

