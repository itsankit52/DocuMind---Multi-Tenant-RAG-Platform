/**
 * Method instrumentation for service singletons (Step 13).
 *
 * Each service module calls its instrumenter once on its exported instance. The wrapper
 * only observes: it returns / throws exactly what the original method returned / threw,
 * and every metric or log call inside it is fail-safe. jest.spyOn() on a wrapped method
 * keeps working (the spy simply replaces the wrapper).
 */

const { metrics: m, safe, secondsSince, boundedLabel } = require('./metrics');
const logger = require('./logger');

/**
 * Wrap obj[name] (sync or async). Hooks receive (value | error, seconds, args).
 */
function wrap(obj, name, { onStart, onSuccess, onError } = {}) {
  const original = obj[name];
  if (typeof original !== 'function' || original.__instrumented) return;

  const wrapped = function instrumented(...args) {
    const start = process.hrtime.bigint();
    if (onStart) safe(() => onStart(args));
    const ok = (value) => {
      if (onSuccess) safe(() => onSuccess(value, secondsSince(start), args));
      return value;
    };
    const fail = (err) => {
      if (onError) safe(() => onError(err, secondsSince(start), args));
      throw err;
    };
    let result;
    try {
      result = original.apply(this, args);
    } catch (err) {
      return fail(err);
    }
    if (result && typeof result.then === 'function') return result.then(ok, fail);
    return ok(result);
  };
  wrapped.__instrumented = true;
  obj[name] = wrapped;
}

const isAbort = (err, args) =>
  (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) ||
  Boolean(args && args[0] && args[0].signal && args[0].signal.aborted);
const isTimeout = (err) => Boolean(err && (err.name === 'TimeoutError' || /timed? ?out/i.test(err.message || '')));

// ── Qdrant: every call goes through _request(path, options) ─────────────────
function qdrantOperation(path = '', method = 'GET') {
  if (/\/points\/(search|query)/.test(path)) return 'search';
  if (/\/points\/delete/.test(path)) return 'delete';
  if (/\/points\/?(\?.*)?$/.test(path) && method === 'PUT') return 'upsert';
  if (/\/points\//.test(path)) return 'get';
  if (path.startsWith('/healthz')) return 'health';
  if (path.startsWith('/collections')) return 'collection';
  return 'other';
}

function instrumentQdrant(service) {
  const op = (args) => qdrantOperation(args[0], ((args[1] && args[1].method) || 'GET').toUpperCase());
  wrap(service, '_request', {
    onSuccess: (_v, secs, args) => {
      const operation = op(args);
      m.qdrantRequests.inc({ operation, status: 'success' });
      m.qdrantDuration.observe({ operation }, secs);
    },
    onError: (err, secs, args) => {
      const operation = op(args);
      m.qdrantRequests.inc({ operation, status: 'error' });
      m.qdrantDuration.observe({ operation }, secs);
      logger.warn('Qdrant operation failed', { operation, durationMs: Math.round(secs * 1000), error: err });
    },
  });
  return service;
}

// ── Embeddings ──────────────────────────────────────────────────────────────
function instrumentEmbeddings(service) {
  wrap(service, 'embedText', {
    onSuccess: (_v, secs) => {
      m.embeddingRequests.inc({ operation: 'single', status: 'success' });
      m.embeddingDuration.observe({ operation: 'single' }, secs);
      m.embeddingTexts.inc();
    },
    onError: (err, secs) => {
      m.embeddingRequests.inc({ operation: 'single', status: 'error' });
      m.embeddingDuration.observe({ operation: 'single' }, secs);
      m.embeddingErrors.inc({ operation: 'single' });
    },
  });
  wrap(service, 'embedTexts', {
    onStart: (args) => Array.isArray(args[0]) && m.embeddingBatchSize.observe(args[0].length),
    onSuccess: (_v, secs) => {
      m.embeddingRequests.inc({ operation: 'batch', status: 'success' });
      m.embeddingDuration.observe({ operation: 'batch' }, secs);
    },
    onError: (err, secs) => {
      m.embeddingRequests.inc({ operation: 'batch', status: 'error' });
      m.embeddingDuration.observe({ operation: 'batch' }, secs);
      m.embeddingErrors.inc({ operation: 'batch' });
      logger.warn('Embedding batch failed', { durationMs: Math.round(secs * 1000), error: err });
    },
  });
  return service;
}

// ── Ollama LLM ──────────────────────────────────────────────────────────────
function instrumentOllama(service) {
  const record = (mode) => ({
    onStart: () => mode === 'stream' && m.ollamaStreamsActive.inc(),
    onSuccess: (_v, secs) => {
      if (mode === 'stream') m.ollamaStreamsActive.dec();
      m.ollamaRequests.inc({ mode, status: 'success' });
      m.ollamaDuration.observe({ mode }, secs);
    },
    onError: (err, secs, args) => {
      if (mode === 'stream') m.ollamaStreamsActive.dec();
      const status = isAbort(err, args) ? 'aborted' : isTimeout(err) ? 'timeout' : 'error';
      m.ollamaRequests.inc({ mode, status });
      m.ollamaDuration.observe({ mode }, secs);
      if (status !== 'aborted') {
        logger.warn('Ollama generation failed', { mode, status, durationMs: Math.round(secs * 1000), error: err });
      }
    },
  });
  wrap(service, 'generateAnswer', record('sync'));
  wrap(service, 'generateStream', record('stream'));
  return service;
}

// ── RAG building blocks ─────────────────────────────────────────────────────
function instrumentRetrieval(service) {
  wrap(service, 'retrieveContext', {
    onSuccess: (chunks, secs) => {
      const count = Array.isArray(chunks) ? chunks.length : 0;
      m.ragRetrievalDuration.observe(secs);
      m.ragRetrievedChunks.observe(count);
      if (count === 0) m.ragRetrievalEmpty.inc();
    },
    onError: (err, secs) => {
      m.ragRetrievalDuration.observe(secs);
      if (!(err && err.statusCode && err.statusCode < 500)) m.ragErrors.inc({ stage: 'retrieval' });
    },
  });
  return service;
}

function instrumentContext(service) {
  wrap(service, 'buildContext', {
    onSuccess: (_v, secs) => m.ragContextDuration.observe(secs),
    onError: () => m.ragErrors.inc({ stage: 'context' }),
  });
  return service;
}

function instrumentRag(service) {
  wrap(service, 'answerQuestion', {
    onSuccess: (result, secs) => {
      const empty = !result || !result.retrieval || result.retrieval.returnedChunks === 0;
      m.ragQueries.inc({ mode: 'sync', status: empty ? 'no_context' : 'success' });
      m.ragDuration.observe({ mode: 'sync' }, secs);
    },
    onError: (err, secs) => {
      const invalid = err && err.statusCode && err.statusCode < 500;
      m.ragQueries.inc({ mode: 'sync', status: invalid ? 'invalid' : 'error' });
      m.ragDuration.observe({ mode: 'sync' }, secs);
      if (!invalid) {
        m.ragErrors.inc({ stage: /LLM/.test((err && err.message) || '') ? 'generation' : 'other' });
        logger.error('RAG query failed', { mode: 'sync', durationMs: Math.round(secs * 1000), error: err });
      }
    },
  });
  return service;
}

const STREAM_STATUS = { completed: 'success', replayed: 'replayed', cancelled: 'cancelled', failed: 'error' };

function instrumentChatStream(service) {
  wrap(service, 'runStream', {
    onSuccess: (result, secs) => {
      const status = STREAM_STATUS[result && result.status] || 'other';
      m.ragQueries.inc({ mode: 'stream', status });
      m.ragDuration.observe({ mode: 'stream' }, secs);
      if (status === 'error') {
        const code = boundedLabel(result.code);
        m.ragErrors.inc({ stage: code === 'LLM_STREAM_ERROR' || code === 'RESPONSE_TOO_LARGE' ? 'generation' : 'stream' });
        logger.warn('Chat stream failed', { code, durationMs: Math.round(secs * 1000) });
      }
    },
    onError: (err, secs) => {
      m.ragQueries.inc({ mode: 'stream', status: 'error' });
      m.ragDuration.observe({ mode: 'stream' }, secs);
      m.ragErrors.inc({ stage: 'stream' });
      logger.error('Chat stream crashed', { durationMs: Math.round(secs * 1000), error: err });
    },
  });
  return service;
}

module.exports = {
  wrap,
  qdrantOperation,
  instrumentQdrant,
  instrumentEmbeddings,
  instrumentOllama,
  instrumentRetrieval,
  instrumentContext,
  instrumentRag,
  instrumentChatStream,
};
