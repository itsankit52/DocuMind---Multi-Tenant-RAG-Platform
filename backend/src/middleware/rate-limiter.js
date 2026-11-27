const redis = require('redis');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { metrics, safe } = require('../observability/metrics');
const logger = require('../observability/logger');
const { redactForClient: redact } = require('./error-handler');

let redisClient = null;

// Bound every Redis wait: a stalled connection must make the limiter fail open quickly
// instead of hanging the request (commands otherwise queue until Redis answers).
const REDIS_OP_TIMEOUT_MS = 1000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis ${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Approved fields only (type, code, redacted message); never the raw error object. */
function safeError(err) {
  if (!err || typeof err !== 'object') return { type: typeof err, message: redact(String(err)) };
  return {
    type: err.name || 'Error',
    ...(typeof err.code === 'string' && /^[A-Z0-9_]{2,32}$/.test(err.code) ? { code: err.code } : {}),
    message: redact(err.message || ''),
  };
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = redis.createClient({
      url: env.REDIS_URL,
      socket: { connectTimeout: REDIS_OP_TIMEOUT_MS * 2 },
    });
    redisClient.on('error', (err) => {
      safe(() => metrics.redisErrors.inc({ operation: 'connection' }));
      // Structured + redacted (the logger is silent under NODE_ENV=test by default)
      logger.error('Redis client error (rate limiter)', { operation: 'connection', error: safeError(err) });
    });
    redisClient.connect().catch((err) => {
      logger.error('Failed to connect to Redis for rate limiting', { operation: 'connect', error: safeError(err) });
    });
  }
  return redisClient;
}

// Initialize client
getRedisClient();

// Public message when a fail-closed limiter cannot reach Redis (never the Redis error itself).
const UNAVAILABLE_MESSAGE = 'Service temporarily unavailable. Please try again shortly.';

/**
 * @param {object}   [options]
 * @param {number}   [options.windowMs]
 * @param {number}   [options.max]
 * @param {Function} [options.keyGenerator]
 * @param {boolean}  [options.failClosed=false]  When Redis fails (connect, command, timeout):
 *   false (default) → the request is allowed (fail-open, unchanged for every existing limiter);
 *   true            → 503 and the request stops here. No in-memory fallback counting.
 */
function rateLimiter(options = {}) {
  const { windowMs = 60 * 1000, max = 100, keyGenerator = (req) => `ratelimit:${req.ip}:${req.baseUrl || req.path}` } = options;
  const failClosed = options.failClosed === true;

  const middleware = async (req, res, next) => {
    const key = keyGenerator(req);
    const client = getRedisClient();

    try {
      if (!client.isOpen) {
        await withTimeout(client.connect(), REDIS_OP_TIMEOUT_MS, 'connect');
      }

      // Atomic: the TTL is created together with the counter, so a crash between two
      // commands can never leave a counter without expiry (a permanent lockout).
      const [, requests] = await withTimeout(
        client
          .multi()
          .set(key, '0', { EX: Math.ceil(windowMs / 1000), NX: true })
          .incr(key)
          .exec(),
        REDIS_OP_TIMEOUT_MS,
        'rate-limit',
      );

      if (requests > max) {
        return next(new AppError('Too many requests, please try again later.', 429));
      }

      next();
    } catch (err) {
      safe(() => metrics.redisErrors.inc({ operation: 'rate_limit' }));
      // Metadata only: never the key, headers, cookies, query or body (requestId comes from context)
      logger.error(`Rate limiter error; request ${failClosed ? 'rejected (fail-closed)' : 'allowed (fail-open)'}`, {
        operation: 'rate_limit',
        failClosed,
        method: req.method,
        route: `${req.baseUrl || ''}${req.path || ''}`,
        error: safeError(err),
      });
      if (failClosed) return next(new AppError(UNAVAILABLE_MESSAGE, 503));
      next(); // Fail-open to avoid blocking users if Redis experiences issues
    }
  };
  // Read-only marker so the wiring of each limiter can be audited/tested.
  Object.defineProperty(middleware, 'failClosed', { value: failClosed, enumerable: true });
  return middleware;
}

module.exports = rateLimiter;
module.exports.getRedisClient = getRedisClient;
module.exports.UNAVAILABLE_MESSAGE = UNAVAILABLE_MESSAGE;

