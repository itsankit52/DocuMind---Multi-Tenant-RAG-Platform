/**
 * Structured JSON logger (Step 13).
 *
 * - One JSON object per line: timestamp, level, service, environment, message, requestId + fields.
 * - requestId / jobId are picked up automatically from the async context (see runWithContext).
 * - Secrets are scrubbed from messages and fields before writing (defence in depth: callers
 *   should still log metadata, never passwords, tokens, prompts or document text).
 * - Logging can never throw into business code.
 */

const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Field names whose values are never written.
const SENSITIVE_KEYS = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|jwt|prompt|content|question|answer|embedding|vector/i;

const REDACTIONS = [
  // credentials embedded in URLs: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@'],
  // bearer tokens
  [/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  // JWTs
  [/eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}/g, '[REDACTED_JWT]'],
];

const MAX_STRING = 2000;

const contextStore = new AsyncLocalStorage();

function redactString(value) {
  let out = String(value);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { type: value.name, message: redactString(value.message), code: value.code };
  }
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return redactString(value);
}

function defaultLevel() {
  if (process.env.LOG_LEVEL && LEVELS[process.env.LOG_LEVEL] !== undefined) return process.env.LOG_LEVEL;
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

const state = {
  level: defaultLevel(),
  format: process.env.LOG_FORMAT === 'pretty' ? 'pretty' : 'json',
  service: 'documind-api',
  environment: process.env.NODE_ENV || 'development',
  write: (line) => process.stdout.write(`${line}\n`),
};

// Original console methods, kept so the logger never recurses through a captured console.
const rawConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function emit(level, message, fields) {
  try {
    if (LEVELS[level] < LEVELS[state.level]) return;
    const ctx = contextStore.getStore() || {};
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: state.service,
      environment: state.environment,
      message: redactString(message),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
      ...sanitize(fields || {}),
    };
    if (state.format === 'pretty') {
      const { timestamp, level: lvl, message: msg, service, environment, ...rest } = entry;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      state.write(`${timestamp} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`);
    } else {
      state.write(JSON.stringify(entry));
    }
  } catch (_) {
    // Observability must never break the caller.
  }
}

const logger = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),

  /** Run fn with request/job context that is attached to every log line inside it. */
  runWithContext: (context, fn) => contextStore.run({ ...(contextStore.getStore() || {}), ...context }, fn),
  getContext: () => contextStore.getStore() || {},

  configure({ level, format, service, environment, write } = {}) {
    if (level && LEVELS[level] !== undefined) state.level = level;
    if (format) state.format = format;
    if (service) state.service = service;
    if (environment) state.environment = environment;
    if (typeof write === 'function') state.write = write;
  },
  getLevel: () => state.level,

  /**
   * Route console.* through the structured logger so legacy log statements become JSON.
   * Used only by the server / worker entrypoints, never in tests.
   */
  captureConsole() {
    const format = (args) => {
      const errors = args.filter(a => a instanceof Error);
      const text = args
        .filter(a => !(a instanceof Error))
        .map(a => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ')
        .replace(/^[^\w[(]+/u, '') // strip leading emoji / symbols
        .trim();
      return { text: text || (errors[0] && errors[0].message) || '', fields: errors[0] ? { error: errors[0] } : undefined };
    };
    const bind = (level) => (...args) => {
      const { text, fields } = format(args);
      emit(level, text, fields);
    };
    console.log = bind('info');
    console.info = bind('info');
    console.warn = bind('warn');
    console.error = bind('error');
    console.debug = bind('debug');
  },
  restoreConsole() {
    Object.assign(console, rawConsole);
  },
};

function safeStringify(value) {
  try {
    return JSON.stringify(sanitize(value));
  } catch (_) {
    return '[unserializable]';
  }
}

module.exports = logger;
module.exports.sanitize = sanitize;
module.exports.redactString = redactString;
