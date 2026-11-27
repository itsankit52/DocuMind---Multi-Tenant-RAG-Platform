/**
 * Centralized Prometheus metrics (Step 13).
 *
 * Rules:
 *   - Labels are LOW-cardinality enums only (method, route template, status, stage, outcome...).
 *     Never user/org/document/conversation/message/request IDs, emails or filenames.
 *   - Recording a metric can never throw into business code (every helper is fail-safe).
 */

const client = require('prom-client');

const register = new client.Registry();

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const SLOW_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300];

// Label keys that must never appear on any metric (enforced by tests/observability).
const FORBIDDEN_LABELS = [
  'user_id', 'userId', 'organization_id', 'organizationId', 'org_id', 'tenant_id', 'tenantId',
  'document_id', 'documentId', 'conversation_id', 'conversationId', 'message_id', 'messageId',
  'request_id', 'requestId', 'job_id', 'jobId', 'chunk_id', 'filename', 'email', 'path', 'url',
];

const counter = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [register] });
const histogram = (name, help, labelNames = [], buckets = LATENCY_BUCKETS) =>
  new client.Histogram({ name, help, labelNames, buckets, registers: [register] });
const gauge = (name, help, labelNames = [], collect) =>
  new client.Gauge({ name, help, labelNames, registers: [register], ...(collect ? { collect } : {}) });

const m = {
  // ── HTTP ────────────────────────────────────────────────────────────────
  httpRequestsTotal: counter('http_requests_total', 'HTTP requests handled', ['method', 'route', 'status_code']),
  httpRequestDuration: histogram('http_request_duration_seconds', 'HTTP request latency', ['method', 'route', 'status_code']),
  httpRequestsInFlight: gauge('http_requests_in_flight', 'HTTP requests currently being processed'),

  // ── Auth / security ─────────────────────────────────────────────────────
  authLoginAttempts: counter('auth_login_attempts_total', 'Login attempts by result', ['result']),
  authTokenRefresh: counter('auth_token_refresh_total', 'Access-token refresh attempts by result', ['result']),
  authDenied: counter('auth_denied_total', 'Requests rejected as unauthorized (401) or forbidden (403)', ['reason']),
  rateLimitExceeded: counter('rate_limit_exceeded_total', 'Requests rejected with 429 by rate limiting', ['route']),

  // ── PostgreSQL ──────────────────────────────────────────────────────────
  dbQueryDuration: histogram('db_query_duration_seconds', 'PostgreSQL query latency', ['operation']),
  dbQueryErrors: counter('db_query_errors_total', 'PostgreSQL query errors', ['operation']),
  dbTransactionErrors: counter('db_transaction_errors_total', 'Tenant transactions rolled back due to an error'),
  dbPoolConnections: gauge('db_pool_connections', 'PostgreSQL pool connections by state', ['state'], function collect() {
    safe(() => {
      const { pool } = require('../db');
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    });
  }),

  // ── Redis ───────────────────────────────────────────────────────────────
  redisErrors: counter('redis_errors_total', 'Redis errors by operation', ['operation']),
  ragEmbeddingCache: counter('rag_query_embedding_cache_total', 'Question embedding cache lookups by result', ['result']),

  // ── RabbitMQ ────────────────────────────────────────────────────────────
  queuePublished: counter('queue_messages_published_total', 'Messages published by queue', ['queue', 'status']),
  queueConsumed: counter('queue_messages_consumed_total', 'Messages delivered to the document worker'),
  queueConsumerErrors: counter('queue_consumer_errors_total', 'Consumer-level failures', ['reason']),
  queueDepth: gauge('queue_depth', 'Messages ready in each document-processing queue', ['queue'], async function collect() {
    try {
      // Only reads depths over an already-open connection; scraping never opens one.
      const depths = await require('../queue/rabbitmq.service').getQueueDepths();
      for (const [queue, count] of Object.entries(depths || {})) this.set({ queue }, count);
    } catch (_) { /* leave last value */ }
  }),
  queueConnected: gauge('queue_connected', '1 when this process holds an open RabbitMQ channel', [], function collect() {
    safe(() => this.set(require('../queue/rabbitmq.service').channel ? 1 : 0));
  }),

  // ── Document processing ─────────────────────────────────────────────────
  processingJobs: counter('document_processing_jobs_total', 'Processing jobs by outcome', ['outcome']),
  processingJobsRecovered: counter('document_processing_jobs_recovered_total',
    'Abandoned processing jobs handled by stale-job recovery, by outcome (requeued, failed, superseded)', ['outcome']),
  processingDuration: histogram('document_processing_duration_seconds', 'End-to-end job processing time', ['outcome'], SLOW_BUCKETS),
  processingStageDuration: histogram('document_processing_stage_duration_seconds', 'Processing time per pipeline stage', ['stage'], SLOW_BUCKETS),
  processingInProgress: gauge('document_processing_in_progress', 'Jobs currently being processed'),
  chunksCreated: counter('document_chunks_created_total', 'Chunks produced by the chunker'),

  // ── Embeddings ──────────────────────────────────────────────────────────
  embeddingRequests: counter('embedding_requests_total', 'Embedding calls to Ollama', ['operation', 'status']),
  embeddingDuration: histogram('embedding_duration_seconds', 'Embedding latency', ['operation'], SLOW_BUCKETS),
  embeddingErrors: counter('embedding_errors_total', 'Embedding failures', ['operation']),
  embeddingTexts: counter('embedding_texts_total', 'Texts (chunks / questions) embedded successfully'),
  embeddingBatchSize: histogram('embedding_batch_size', 'Texts per batch embedding call', [], [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000]),

  // ── Qdrant ──────────────────────────────────────────────────────────────
  qdrantRequests: counter('qdrant_requests_total', 'Qdrant operations', ['operation', 'status']),
  qdrantDuration: histogram('qdrant_request_duration_seconds', 'Qdrant operation latency', ['operation']),

  // ── RAG ─────────────────────────────────────────────────────────────────
  ragQueries: counter('rag_queries_total', 'RAG queries by mode and status', ['mode', 'status']),
  ragDuration: histogram('rag_duration_seconds', 'Total RAG latency', ['mode'], SLOW_BUCKETS),
  ragRetrievalDuration: histogram('rag_retrieval_duration_seconds', 'Retrieval latency (embed + search + RLS check)'),
  ragContextDuration: histogram('rag_context_build_duration_seconds', 'Context assembly latency', [], [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5]),
  ragRetrievedChunks: histogram('rag_retrieved_chunks', 'Chunks returned by retrieval', [], [0, 1, 2, 3, 5, 8, 10, 20]),
  ragRetrievalEmpty: counter('rag_retrieval_empty_total', 'Retrievals that returned no usable chunks'),
  ragErrors: counter('rag_errors_total', 'RAG failures by stage', ['stage']),

  // ── Ollama LLM ──────────────────────────────────────────────────────────
  ollamaRequests: counter('ollama_requests_total', 'LLM generation calls', ['mode', 'status']),
  ollamaDuration: histogram('ollama_request_duration_seconds', 'LLM generation latency', ['mode'], SLOW_BUCKETS),
  ollamaStreamsActive: gauge('ollama_streams_active', 'LLM streaming generations in progress'),

  // ── SSE ─────────────────────────────────────────────────────────────────
  sseStreamsStarted: counter('sse_streams_started_total', 'SSE streams opened'),
  sseStreams: counter('sse_streams_total', 'SSE streams finished, by outcome', ['outcome']),
  sseStreamDuration: histogram('sse_stream_duration_seconds', 'SSE stream lifetime', ['outcome'], SLOW_BUCKETS),
  sseStreamErrors: counter('sse_stream_errors_total', 'SSE error events sent, by error code', ['code']),
  sseStreamsActive: gauge('sse_streams_active', 'SSE streams currently open', [], function collect() {
    safe(() => this.set(require('../sse/sse-session').streamRegistry.activeCount()));
  }),

  // ── Health ──────────────────────────────────────────────────────────────
  dependencyUp: gauge('dependency_up', '1 when the dependency passed its last readiness check', ['dependency']),
  dependencyCheckDuration: histogram('dependency_check_duration_seconds', 'Readiness-check latency', ['dependency']),
  workerUp: gauge('worker_consumer_active', '1 while the document worker is consuming from RabbitMQ'),
};

let defaultsStarted = false;

/** Process-level defaults (CPU, memory, event loop, start time). Called by entrypoints only. */
function init({ service = 'documind-api' } = {}) {
  register.setDefaultLabels({ service });
  if (!defaultsStarted) {
    client.collectDefaultMetrics({ register });
    defaultsStarted = true;
  }
}

/** Run a metric operation; swallow any error so business logic is never affected. */
function safe(fn) {
  try {
    fn();
  } catch (_) {
    /* observability must not break the caller */
  }
}

/** Seconds elapsed since a process.hrtime.bigint() start. */
function secondsSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e9;
}

/** Map a whitelisted code-like string to itself, anything else to 'other'. */
function boundedLabel(value, allowed) {
  if (allowed) return allowed.includes(value) ? value : 'other';
  return typeof value === 'string' && /^[A-Za-z_]{1,40}$/.test(value) ? value : 'other';
}

module.exports = {
  client,
  register,
  metrics: m,
  init,
  safe,
  secondsSince,
  boundedLabel,
  FORBIDDEN_LABELS,
};
