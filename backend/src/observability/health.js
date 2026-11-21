/**
 * Health endpoints (Step 13).
 *
 *   GET /health        — unchanged Step 4 contract (process is up)
 *   GET /health/live   — liveness: the process answers; never touches dependencies
 *   GET /health/ready  — readiness: required dependencies reachable within a timeout
 *
 * Responses expose only dependency names, up/down and latency — never hosts, URLs,
 * credentials, error text or tenant data. Failure details go to the (redacted) log.
 */

const express = require('express');
const env = require('../config/env');
const logger = require('./logger');
const { metrics: m, safe } = require('./metrics');

const startedAt = Date.now();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`check timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve().then(() => promise), timeout]).finally(() => clearTimeout(timer));
}

const expectHealthy = (result) => {
  if (!result || result.status !== 'healthy') throw new Error((result && result.error) || 'unhealthy');
};

/**
 * Default dependency checks. Required ones gate readiness; Redis and Ollama are optional (the rate limiter
 * fails open; chat/RAG report their own 503) -> "degraded".
 * Modules are loaded lazily so importing this file never opens connections.
 */
const DEFAULT_CHECKS = {
  postgres: { required: true, run: () => require('../db').pool.query('SELECT 1') },
  redis: {
    required: false,
    run: async () => {
      const client = require('../middleware/rate-limiter').getRedisClient();
      if (!client.isReady) throw new Error('redis client not ready');
      await client.ping();
    },
  },
  rabbitmq: { required: true, run: () => require('../queue/rabbitmq.service').connect() },
  minio: {
    required: true,
    run: async () => {
      const minio = require('../storage/minio.service');
      if (!(await minio.client.bucketExists(minio.defaultBucket))) throw new Error('bucket missing');
    },
  },
  qdrant: { required: true, run: async () => expectHealthy(await require('../vector/qdrant.service').healthCheck()) },
  // Optional: an LLM outage degrades chat/RAG (they return 503 themselves) but must not take
  // the whole API out of rotation — auth, documents and conversation history keep working.
  ollama: { required: false, run: async () => expectHealthy(await require('../llm/ollama.service').healthCheck()) },
};

async function runChecks(checks, timeoutMs) {
  const entries = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    const start = Date.now();
    let up = true;
    try {
      await withTimeout(check.run(), timeoutMs);
    } catch (err) {
      up = false;
      logger.warn('Readiness check failed', { dependency: name, error: err });
    }
    const latencyMs = Date.now() - start;
    safe(() => {
      m.dependencyUp.set({ dependency: name }, up ? 1 : 0);
      m.dependencyCheckDuration.observe({ dependency: name }, latencyMs / 1000);
    });
    return [name, { status: up ? 'up' : 'down', required: check.required, latencyMs }];
  }));
  return Object.fromEntries(entries);
}

function createHealthRouter({ checks = DEFAULT_CHECKS, timeoutMs = env.HEALTH_CHECK_TIMEOUT_MS } = {}) {
  const router = express.Router();

  // Step 4 contract — kept byte-for-byte compatible.
  router.get('/', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'documind-api',
      environment: env.NODE_ENV,
    });
  });

  router.get('/live', (req, res) => {
    res.status(200).json({
      status: 'alive',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (req, res) => {
    const results = await runChecks(checks, timeoutMs);
    const requiredDown = Object.values(results).some(r => r.required && r.status === 'down');
    const optionalDown = Object.values(results).some(r => !r.required && r.status === 'down');
    const status = requiredDown ? 'not_ready' : optionalDown ? 'degraded' : 'ready';
    res.status(requiredDown ? 503 : 200).json({ status, timestamp: new Date().toISOString(), checks: results });
  });

  return router;
}

module.exports = { createHealthRouter, runChecks, withTimeout, DEFAULT_CHECKS };
