/**
 * Centralized Express error handler (Phase 3.2D / F8).
 *
 * Responses:
 *  - default (production, test, or NODE_ENV not explicitly 'development'):
 *      { status, message, code? } — the message only for operational AppErrors, otherwise
 *      'Something went wrong!'. No stack, no error object, no cause.
 *  - developmentDiagnostics (only when the PROCESS environment says NODE_ENV=development):
 *      the same fields plus a safe `error` summary and a redacted `stack`. The original
 *      error object and its nested `cause` (driver detail, SQL, raw request bodies) are
 *      never serialized.
 * The mode is fixed when the handler is created; nothing in a request can change it.
 * The correlation ID is returned in the X-Request-Id header (observability/http.js).
 */

const env = require('../config/env');
const logger = require('../observability/logger');

/** Detailed diagnostics need an explicit NODE_ENV=development (no default, no request input). */
function developmentDiagnosticsEnabled(rawNodeEnv) {
  return rawNodeEnv === 'development';
}

// Configured secret values are scrubbed verbatim wherever they might appear.
const SECRET_ENV_KEYS = /URL|SECRET|PASSWORD|KEY|TOKEN/i;
function configuredSecrets() {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_KEYS.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
}

const DEV_REDACTIONS = [
  // key=value / key: value credential pairs
  [/\b(pass(?:word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[REDACTED]'],
  // invitation-token shaped values (32 random bytes, base64url) and SHA-256 hex digests
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '[REDACTED_TOKEN]'],
  [/(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/gi, '[REDACTED_HASH]'],
  // user email addresses (e.g. inside driver/SQL text)
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
];

function redactForClient(value) {
  let out = logger.redactString(String(value || '')); // URL credentials, bearer tokens, JWTs
  for (const secret of configuredSecrets()) out = out.split(secret).join('[REDACTED]');
  for (const [pattern, replacement] of DEV_REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** Only scalar, non-sensitive facts about the error; the cause contributes its type and code. */
function errorSummary(err) {
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : null;
  const safeCode = (c) => (typeof c === 'string' && /^[A-Z0-9_]{2,32}$/.test(c) ? c : undefined);
  return {
    type: err.name || 'Error',
    statusCode: err.statusCode,
    isOperational: Boolean(err.isOperational),
    ...(cause ? { causeType: cause.name || 'Error' } : {}),
    ...(cause && safeCode(cause.code) ? { causeCode: cause.code } : {}),
  };
}

function createErrorHandler({ developmentDiagnostics = false } = {}) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) {
      return next(err);
    }

    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Structured error log correlated by requestId (bodies, tokens and passwords are never logged).
    // F8.2: the message and stack go through the same redaction as client diagnostics (the global
    // logger does not redact emails); the shape matches logger.sanitize ({ type, message, code })
    // and the cause is never included.
    if (err.statusCode >= 500) {
      logger.error('Request failed', {
        requestId: req.requestId,
        method: req.method,
        statusCode: err.statusCode,
        error: { type: err.name, message: redactForClient(err.message), code: err.code },
        ...(err.isOperational ? {} : { stack: redactForClient(String(err.stack || '').split('\n').slice(0, 8).join('\n')) }),
      });
    }

    if (developmentDiagnostics) {
      return res.status(err.statusCode).json({
        status: err.status,
        message: redactForClient(err.message),
        ...(err.errorCode ? { code: err.errorCode } : {}),
        error: errorSummary(err),
        stack: redactForClient(err.stack),
      });
    }

    // Production / Test: don't leak stack traces
    return res.status(err.statusCode).json({
      status: err.status,
      message: err.isOperational ? err.message : 'Something went wrong!',
      ...(err.isOperational && err.errorCode ? { code: err.errorCode } : {}),
    });
  };
}

// redactForClient is also used for rate-limiter log messages (configured secrets, URL
// credentials, key=value credentials, token/hash/email shapes).
module.exports = { createErrorHandler, developmentDiagnosticsEnabled, redactForClient };
