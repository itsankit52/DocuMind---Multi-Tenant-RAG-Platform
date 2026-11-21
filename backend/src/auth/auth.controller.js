const express = require('express');
const zod = require('zod');
const jwt = require('jsonwebtoken');
const authService = require('../auth/auth.service');
const AppError = require('../utils/AppError');
const authMiddleware = require('../middleware/auth');
const orgRepo = require('../repositories/org.repository');
const userRepo = require('../repositories/user.repository');
const rateLimiter = require('../middleware/rate-limiter');
const env = require('../config/env');

const router = express.Router();

const authRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `ratelimit:auth:${req.ip}:${req.baseUrl || ''}${req.path}`,
});

const registerSchema = zod.object({
  email: zod.string().trim().toLowerCase().email('Please provide a valid email address'),
  password: zod.string()
    .min(8, 'Password must be at least 8 characters long')
    .max(128, 'Password must be at most 128 characters long'),
  fullName: zod.string().trim().max(200, 'Full name is too long').optional(),
});

const loginSchema = zod.object({
  email: zod.string().trim().toLowerCase().email('Please provide a valid email address'),
  password: zod.string().min(1, 'Password is required').max(128, 'Invalid credentials'),
});

router.post('/register', authRateLimiter, async (req, res, next) => {
  try {
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(AppError.fromZod(parseResult.error));
    }

    const user = await authService.register(parseResult.data);
    res.status(201).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          status: user.status,
          createdAt: user.created_at,
        },
      },
    });
  } catch (err) {
    next(AppError.from(err));
  }
});

router.post('/login', authRateLimiter, async (req, res, next) => {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(AppError.fromZod(parseResult.error));
    }

    const { email, password } = parseResult.data;
    const { user, tokens } = await authService.login(email, password);

    res.cookie('accessToken', tokens.accessToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 15 * 60 * 1000, // 15 mins
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
        },
        accessToken: tokens.accessToken,
      },
    });
  } catch (err) {
    next(AppError.from(err, 'Login failed.', 500));
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const refreshToken = (req.cookies && req.cookies.refreshToken) || req.body.refreshToken;

    if (!refreshToken) {
      return next(new AppError('Refresh token is required.', 400));
    }

    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
    const user = await userRepo.findById(decoded.userId);

    if (!user || user.status !== 'active') {
      return next(new AppError('Invalid refresh token or user is no longer active.', 401));
    }

    const tokens = authService.generateTokens(user);

    res.cookie('accessToken', tokens.accessToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      status: 'success',
      data: {
        accessToken: tokens.accessToken,
      },
    });
  } catch (err) {
    next(new AppError('Invalid or expired refresh token.', 401));
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.status(200).json({ status: 'success', message: 'Logged out successfully' });
});

router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const orgs = await orgRepo.findMembershipsByUser(req.user.id);
    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: req.user.id,
          email: req.user.email,
          fullName: req.user.full_name,
          status: req.user.status,
        },
        organizations: orgs,
      },
    });
  } catch (err) {
    next(AppError.from(err));
  }
});

module.exports = router;

