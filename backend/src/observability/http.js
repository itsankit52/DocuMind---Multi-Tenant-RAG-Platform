/**
 * HTTP observability (Step 13): request metrics, access logs, request context, GET /metrics.
 */

const crypto = require('crypto');
const { uuidv7 } = require('uuidv7');
const env = require('../config/env');
const logger = require('./logger');
const { register, metrics: m, safe, secondsSince } = require('./metrics');

// Client-supplied request IDs are echoed in headers and logs, so only accept safe tokens.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns the correlation ID (reusing a safe client X-Request-Id), returns it in the
 * X-Request-Id response header and binds it to the async log context for the request.
 */
function requestContext(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv7();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  logger.runWithContext({ requestId }, next);
}

/** Remember the router mount path so the route label survives error handling. */
function tagRoute(req, res, next) {
  req.metricsBase = req.baseUrl;
  next();
}

/** Route TEMPLATE for labels (e.g. /api/documents/:documentId) — never the raw URL. */
function routeLabel(req) {
  const base = req.metricsBase || '';
  if (req.route && typeof req.route.path === 'string') {
    const path = req.route.path === '/' && base ? '' : req.route.path;
    return `${base}${path}` || '/';
  }
  // Mounted router reached, but no route matched or a middleware rejected (401/403/429...).
  return base ? `${base}/*` : 'unmatched';
}

const QUIET_ROUTES = new Set(['/metrics', '/health', '/health/live', '/health/ready']);

function recordAuthSignals(method, route, status) {
  if (method === 'POST' && route === '/api/auth/login') {
    const result = status < 300 ? 'success' : status === 429 ? 'rate_limited'
      : status === 400 ? 'invalid_request' : status < 500 ? 'failure' : 'error';
    m.authLoginAttempts.inc({ result });
  }
  if (method === 'POST' && route === '/api/auth/refresh') {
    m.authTokenRefresh.inc({ result: status < 300 ? 'success' : status < 500 ? 'failure' : 'error' });
  }
  if (status === 401) m.authDenied.inc({ reason: 'unauthorized' });
  if (status === 403) m.authDenied.inc({ reason: 'forbidden' });
  if (status === 429) m.rateLimitExceeded.inc({ route });
}

/** Records http_requests_total / http_request_duration_seconds and writes one access log line. */
function httpMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  const requestId = req.requestId;
  safe(() => m.httpRequestsInFlight.inc());

  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    const seconds = secondsSince(start);
    const route = routeLabel(req);
    const method = req.method;
    const status = res.statusCode;
    safe(() => {
      m.httpRequestsInFlight.dec();
      const labels = { method, route, status_code: String(status) };
      m.httpRequestsTotal.inc(labels);
      m.httpRequestDuration.observe(labels, seconds);
      recordAuthSignals(method, route, status);
    });

    const level = QUIET_ROUTES.has(route) ? 'debug' : status >= 500 ? 'error' : status === 429 ? 'warn' : 'info';
    logger[level]('HTTP request completed', {
      requestId,
      method,
      route,
      path: (req.originalUrl || '').split('?')[0],
      statusCode: status,
      durationMs: Math.round(seconds * 1000),
      ...(res.writableFinished ? {} : { aborted: true }),
    });
  };
  res.on('finish', record);
  res.on('close', record);
  next();
}

// ── GET /metrics ────────────────────────────────────────────────────────────

function isPrivateAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip);
}

function tokenMatches(header, token) {
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Prometheus scrape endpoint.
 * Protection: METRICS_TOKEN set -> Bearer token required; otherwise only loopback /
 * private-network clients (the socket address, not X-Forwarded-For) may scrape.
 */
async function metricsHandler(req, res) {
  if (!env.METRICS_ENABLED) return res.status(404).json({ status: 'fail', message: 'Not found' });

  const allowed = env.METRICS_TOKEN
    ? tokenMatches(req.headers.authorization, env.METRICS_TOKEN)
    : isPrivateAddress(req.socket && req.socket.remoteAddress);
  if (!allowed) return res.status(403).json({ status: 'fail', message: 'Forbidden' });

  try {
    const body = await register.metrics();
    res.setHeader('Content-Type', register.contentType);
    return res.status(200).send(body);
  } catch (err) {
    logger.error('Metrics collection failed', { error: err });
    return res.status(500).json({ status: 'error', message: 'Metrics unavailable' });
  }
}

module.exports = {
  requestContext,
  tagRoute,
  httpMetrics,
  metricsHandler,
  routeLabel,
  isPrivateAddress,
  tokenMatches,
};
