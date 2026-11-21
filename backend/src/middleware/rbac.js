const AppError = require('../utils/AppError');

function checkRole(allowedRoles) {
  const normalizedAllowed = allowedRoles.map(r => r.toLowerCase());

  return (req, res, next) => {
    const userRole = (res.locals.userRole || req.userRole || '').toLowerCase();

    if (!userRole || !normalizedAllowed.includes(userRole)) {
      return next(new AppError('You do not have the required permissions to perform this action in this organization.', 403));
    }
    next();
  };
}

module.exports = { checkRole };

