const jwt = require('jsonwebtoken');
const env = require('../config/env');
const userRepo = require('../repositories/user.repository');
const AppError = require('../utils/AppError');

async function authMiddleware(req, res, next) {
  let token = req.cookies && req.cookies.accessToken;

  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(new AppError('You are not logged in. Please log in to continue.', 401));
  }

  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    const user = await userRepo.findById(decoded.userId);

    if (!user || user.status !== 'active') {
      return next(new AppError('The user associated with this token no longer exists or is inactive.', 401));
    }

    req.user = user;
    next();
  } catch (err) {
    return next(new AppError('Invalid or expired token. Please log in again.', 401));
  }
}

module.exports = authMiddleware;
