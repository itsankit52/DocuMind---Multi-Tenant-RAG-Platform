const redis = require('redis');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { metrics, safe } = require('../observability/metrics');

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

function getRedisClient() {
  if (!redisClient) {
    redisClient = redis.createClient({
      url: env.REDIS_URL,
      socket: { connectTimeout: REDIS_OP_TIMEOUT_MS * 2 },
    });
    redisClient.on('error', (err) => {
      safe(() => metrics.redisErrors.inc({ operation: 'connection' }));
      // Avoid spamming logs in tests if redis is stopping
      if (process.env.NODE_ENV !== 'test') {
        console.error('Redis Client Error', err);
      }
    });
    redisClient.connect().catch((err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('Failed to connect to Redis for Rate Limiting:', err.message);
      }
    });
  }
  return redisClient;
}

// Initialize client
getRedisClient();

function rateLimiter(options = {}) {
  const { windowMs = 60 * 1000, max = 100, keyGenerator = (req) => `ratelimit:${req.ip}:${req.baseUrl || req.path}` } = options;

  return async (req, res, next) => {
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
      if (process.env.NODE_ENV !== 'test') {
        console.error('Rate Limiter Error:', err);
      }
      next(); // Fail-open to avoid blocking users if Redis experiences issues
    }
  };
}

module.exports = rateLimiter;
module.exports.getRedisClient = getRedisClient;

