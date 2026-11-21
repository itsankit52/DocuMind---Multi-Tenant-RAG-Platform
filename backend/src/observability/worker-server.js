/**
 * Worker observability server (Step 13).
 *
 * The document worker has no HTTP API, so it exposes a tiny server for Prometheus and probes:
 *   GET /metrics       — Prometheus text format (same protection rules as the API)
 *   GET /health/live   — process alive
 *   GET /health/ready  — consuming from RabbitMQ and PostgreSQL reachable
 */

const http = require('http');
const env = require('../config/env');
const logger = require('./logger');
const { register, metrics: m, safe } = require('./metrics');
const { isPrivateAddress, tokenMatches } = require('./http');
const { withTimeout } = require('./health');

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isConsuming    - worker is running with an open consumer channel
 * @param {() => Promise<void>} opts.checkDb  - throws when PostgreSQL is unreachable
 */
function createWorkerServer({ isConsuming, checkDb }) {
  return http.createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0];
      safe(() => m.workerUp.set(isConsuming() ? 1 : 0));

      if (path === '/health/live') return send(res, 200, { status: 'alive' });

      if (path === '/health/ready') {
        let dbUp = true;
        try {
          await withTimeout(checkDb(), env.HEALTH_CHECK_TIMEOUT_MS);
        } catch (_) {
          dbUp = false;
        }
        const consuming = isConsuming();
        const ready = consuming && dbUp;
        return send(res, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          checks: { rabbitmq_consumer: consuming ? 'up' : 'down', postgres: dbUp ? 'up' : 'down' },
        });
      }

      if (path === '/metrics') {
        if (!env.METRICS_ENABLED) return send(res, 404, { status: 'fail', message: 'Not found' });
        const allowed = env.METRICS_TOKEN
          ? tokenMatches(req.headers.authorization, env.METRICS_TOKEN)
          : isPrivateAddress(req.socket && req.socket.remoteAddress);
        if (!allowed) return send(res, 403, { status: 'fail', message: 'Forbidden' });
        return send(res, 200, await register.metrics(), register.contentType);
      }

      return send(res, 404, { status: 'fail', message: 'Not found' });
    } catch (err) {
      logger.error('Worker observability endpoint failed', { error: err });
      return send(res, 500, { status: 'error' });
    }
  });
}

module.exports = { createWorkerServer };
