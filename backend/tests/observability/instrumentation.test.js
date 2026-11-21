/**
 * Step 13 — RAG / LLM / embedding / Qdrant / processing / SSE / DB instrumentation.
 * External calls are stubbed; no database rows are created or truncated by this suite.
 */

const { EventEmitter } = require('events');
const { pool, sqlOperation } = require('../../src/db');
const ragService = require('../../src/rag/rag.service');
const embeddingService = require('../../src/embeddings/embedding.service');
const qdrantService = require('../../src/vector/qdrant.service');
const ollamaService = require('../../src/llm/ollama.service');
const auditRepo = require('../../src/repositories/audit.repository');
const jobRepo = require('../../src/repositories/job.repository');
const docRepo = require('../../src/repositories/document.repository');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const DocumentProcessor = require('../../src/workers/processor');
const { SseSession, streamRegistry } = require('../../src/sse/sse-session');
const { qdrantOperation } = require('../../src/observability/instrument');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const { metricValue } = require('./obs.helpers');

const ORG = '0190f7a2-0000-7000-8000-000000000001';

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  const redis = getRedisClient();
  if (redis && redis.isOpen) await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
});

describe('RAG metrics', () => {
  test('a query with no matching chunks counts as no_context and an empty retrieval', async () => {
    jest.spyOn(embeddingService, 'embedText').mockResolvedValue(new Array(768).fill(0.1));
    jest.spyOn(qdrantService, 'searchPoints').mockResolvedValue([]);
    jest.spyOn(auditRepo, 'log').mockResolvedValue();

    const before = {
      queries: await metricValue('rag_queries_total', { mode: 'sync', status: 'no_context' }),
      empty: await metricValue('rag_retrieval_empty_total'),
      retrieval: await metricValue('rag_retrieval_duration_seconds_count'),
      total: await metricValue('rag_duration_seconds_count', { mode: 'sync' }),
    };
    const result = await ragService.answerQuestion({ organizationId: ORG, userId: null, question: 'What is the leave policy?' });

    expect(result.retrieval.returnedChunks).toBe(0);
    expect(await metricValue('rag_queries_total', { mode: 'sync', status: 'no_context' })).toBe(before.queries + 1);
    expect(await metricValue('rag_retrieval_empty_total')).toBe(before.empty + 1);
    expect(await metricValue('rag_retrieval_duration_seconds_count')).toBe(before.retrieval + 1);
    expect(await metricValue('rag_duration_seconds_count', { mode: 'sync' })).toBe(before.total + 1);
  });

  test('a retrieval failure is counted as a RAG error and still propagates unchanged', async () => {
    jest.spyOn(embeddingService, 'embedText').mockRejectedValue(new Error('ollama down'));
    const before = {
      errors: await metricValue('rag_queries_total', { mode: 'sync', status: 'error' }),
      stage: await metricValue('rag_errors_total', { stage: 'retrieval' }),
    };
    await expect(ragService.answerQuestion({ organizationId: ORG, question: 'anything?' }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await metricValue('rag_queries_total', { mode: 'sync', status: 'error' })).toBe(before.errors + 1);
    expect(await metricValue('rag_errors_total', { stage: 'retrieval' })).toBe(before.stage + 1);
  });

  test('client validation errors are "invalid", not errors', async () => {
    const before = await metricValue('rag_queries_total', { mode: 'sync', status: 'invalid' });
    await expect(ragService.answerQuestion({ organizationId: ORG, question: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    expect(await metricValue('rag_queries_total', { mode: 'sync', status: 'invalid' })).toBe(before + 1);
  });
});

describe('Ollama / embedding / Qdrant metrics', () => {
  test('LLM generation success and failure are counted by mode and status', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'Answer' }) })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const ok = await metricValue('ollama_requests_total', { mode: 'sync', status: 'success' });
    const failed = await metricValue('ollama_requests_total', { mode: 'sync', status: 'error' });

    await expect(ollamaService.generateAnswer({ userQuestion: 'q', contextText: 'c' })).resolves.toBe('Answer');
    await expect(ollamaService.generateAnswer({ userQuestion: 'q', contextText: 'c' })).rejects.toThrow(/Failed to connect/);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await metricValue('ollama_requests_total', { mode: 'sync', status: 'success' })).toBe(ok + 1);
    expect(await metricValue('ollama_requests_total', { mode: 'sync', status: 'error' })).toBe(failed + 1);
  });

  test('an aborted LLM stream counts as aborted and the active gauge is restored', async () => {
    const controller = new AbortController();
    controller.abort();
    jest.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const active = await metricValue('ollama_streams_active');
    const before = await metricValue('ollama_requests_total', { mode: 'stream', status: 'aborted' });
    await expect(ollamaService.generateStream({ userQuestion: 'q', contextText: 'c', signal: controller.signal })).rejects.toThrow();
    expect(await metricValue('ollama_requests_total', { mode: 'stream', status: 'aborted' })).toBe(before + 1);
    expect(await metricValue('ollama_streams_active')).toBe(active);
  });

  test('embedding calls record requests, errors, texts and batch size', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: new Array(768).fill(0.5) }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    const before = {
      ok: await metricValue('embedding_requests_total', { operation: 'single', status: 'success' }),
      err: await metricValue('embedding_errors_total', { operation: 'batch' }),
      texts: await metricValue('embedding_texts_total'),
      batches: await metricValue('embedding_batch_size_count'),
    };
    await expect(embeddingService.embedTexts(['one', 'two'], { concurrency: 1 })).rejects.toThrow();
    expect(await metricValue('embedding_requests_total', { operation: 'single', status: 'success' })).toBe(before.ok + 1);
    expect(await metricValue('embedding_texts_total')).toBe(before.texts + 1);
    expect(await metricValue('embedding_errors_total', { operation: 'batch' })).toBe(before.err + 1);
    expect(await metricValue('embedding_batch_size_count')).toBe(before.batches + 1);
  });

  test('Qdrant operations are labelled by operation type only', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => JSON.stringify({ result: [] }) });
    const before = await metricValue('qdrant_requests_total', { operation: 'search', status: 'success' });
    await qdrantService.searchPoints('documind_chunks', { vector: [0.1, 0.2], organizationId: ORG, limit: 3 });
    expect(await metricValue('qdrant_requests_total', { operation: 'search', status: 'success' })).toBe(before + 1);

    expect(qdrantOperation('/collections/c/points/search', 'POST')).toBe('search');
    expect(qdrantOperation('/collections/c/points?wait=true', 'PUT')).toBe('upsert');
    expect(qdrantOperation('/collections/c/points/delete?wait=true', 'POST')).toBe('delete');
    expect(qdrantOperation('/collections/c/points/0190f7a2-aaaa', 'GET')).toBe('get');
    expect(qdrantOperation('/collections/c', 'GET')).toBe('collection');
    expect(qdrantOperation('/healthz', 'GET')).toBe('health');
  });
});

describe('Document processing metrics', () => {
  const processor = new DocumentProcessor('test-worker');
  const controls = () => ({ ack: jest.fn(), nack: jest.fn(), retry: jest.fn() });

  test('invalid payloads are counted and dead-lettered', async () => {
    jest.spyOn(rabbitmqService, 'publishDeadLetter').mockResolvedValue(true);
    const before = await metricValue('document_processing_jobs_total', { outcome: 'invalid' });
    const c = controls();
    await processor.processJob({ event: 'x' }, c);
    expect(c.ack).toHaveBeenCalled();
    expect(await metricValue('document_processing_jobs_total', { outcome: 'invalid' })).toBe(before + 1);
  });

  test('transient failures are counted as retried', async () => {
    jest.spyOn(jobRepo, 'findById').mockResolvedValue({ id: 'job-1', organization_id: ORG, document_id: '0190f7a2-0000-7000-8000-00000000d0c1', status: 'queued' });
    jest.spyOn(jobRepo, 'claimJob').mockResolvedValue({ id: 'job-1', attempts: 1, max_attempts: 3 });
    jest.spyOn(jobRepo, 'lockForProcessing').mockResolvedValue({ id: 'job-1' });
    jest.spyOn(jobRepo, 'updateJobStatus').mockResolvedValue();
    jest.spyOn(docRepo, 'findById').mockRejectedValue(new Error('connection reset by peer'));
    const before = await metricValue('document_processing_jobs_total', { outcome: 'retried' });
    const inProgress = await metricValue('document_processing_in_progress');
    const c = controls();
    await processor.processJob({ jobId: 'job-1', documentId: '0190f7a2-0000-7000-8000-00000000d0c1' }, c);
    expect(c.retry).toHaveBeenCalled();
    expect(await metricValue('document_processing_jobs_total', { outcome: 'retried' })).toBe(before + 1);
    expect(await metricValue('document_processing_in_progress')).toBe(inProgress);
  });

  test('permanent failures are counted as failed with a duration', async () => {
    jest.spyOn(jobRepo, 'findById').mockResolvedValue({ id: 'job-2', organization_id: ORG, document_id: '0190f7a2-0000-7000-8000-00000000d0c2', status: 'queued' });
    jest.spyOn(jobRepo, 'claimJob').mockResolvedValue({ id: 'job-2', attempts: 3, max_attempts: 3 });
    jest.spyOn(jobRepo, 'lockForProcessing').mockResolvedValue({ id: 'job-2' });
    jest.spyOn(jobRepo, 'updateJobStatus').mockResolvedValue();
    jest.spyOn(docRepo, 'findById').mockResolvedValue(null); // -> "not found" (permanent)
    jest.spyOn(auditRepo, 'log').mockResolvedValue();
    const dlq = jest.spyOn(rabbitmqService, 'publishDeadLetter').mockResolvedValue(true);
    const before = {
      failed: await metricValue('document_processing_jobs_total', { outcome: 'failed' }),
      duration: await metricValue('document_processing_duration_seconds_count', { outcome: 'failed' }),
    };
    const c = controls();
    await processor.processJob({ jobId: 'job-2', documentId: '0190f7a2-0000-7000-8000-00000000d0c2' }, c);
    expect(dlq).toHaveBeenCalled();
    expect(c.ack).toHaveBeenCalled();
    expect(await metricValue('document_processing_jobs_total', { outcome: 'failed' })).toBe(before.failed + 1);
    expect(await metricValue('document_processing_duration_seconds_count', { outcome: 'failed' })).toBe(before.duration + 1);
  });
});

describe('SSE stream metrics', () => {
  function fakeHttp() {
    const res = new EventEmitter();
    Object.assign(res, {
      writableEnded: false, destroyed: false, headersSent: false,
      setHeader() {}, writeHead() {}, flushHeaders() {}, status() { return res; },
      write: () => true,
      end() { res.writableEnded = true; },
    });
    return { req: { socket: { destroyed: false } }, res };
  }
  const open = () => {
    const { req, res } = fakeHttp();
    const session = new SseSession(req, res, { heartbeatIntervalMs: 60000, timeoutMs: 60000, graceMs: 10 });
    session.start();
    return { session, res };
  };

  test('completed streams increment counters and clean up the active gauge', async () => {
    const base = await metricValue('sse_streams_active');
    const started = await metricValue('sse_streams_started_total');
    const completed = await metricValue('sse_streams_total', { outcome: 'completed' });
    const { session } = open();
    expect(await metricValue('sse_streams_active')).toBe(base + 1);
    session.emit('token', { text: 'hi' });
    session.emit('done', { finishReason: 'stop' });
    expect(await metricValue('sse_streams_started_total')).toBe(started + 1);
    expect(await metricValue('sse_streams_total', { outcome: 'completed' })).toBe(completed + 1);
    expect(await metricValue('sse_streams_active')).toBe(base);
    expect(streamRegistry.activeCount()).toBe(base);
  });

  test('error events are counted by bounded error code', async () => {
    const errors = await metricValue('sse_streams_total', { outcome: 'error' });
    const byCode = await metricValue('sse_stream_errors_total', { code: 'LLM_STREAM_ERROR' });
    const { session } = open();
    session.emit('error', { code: 'LLM_STREAM_ERROR', message: 'safe message' });
    session.emit('done', {}); // ignored after a terminal event — must not double count
    expect(await metricValue('sse_streams_total', { outcome: 'error' })).toBe(errors + 1);
    expect(await metricValue('sse_stream_errors_total', { code: 'LLM_STREAM_ERROR' })).toBe(byCode + 1);
  });

  test('client disconnects and timeouts are distinguished', async () => {
    const base = await metricValue('sse_streams_active');
    const disconnects = await metricValue('sse_streams_total', { outcome: 'client_disconnected' });
    const timeouts = await metricValue('sse_streams_total', { outcome: 'timeout' });

    const a = open();
    a.res.emit('close'); // socket closed before the response ended
    expect(a.session.signal.aborted).toBe(true);

    const b = open();
    b.session.abort('STREAM_TIMEOUT');
    await new Promise(r => setTimeout(r, 30)); // grace timer forces the terminal error event

    expect(await metricValue('sse_streams_total', { outcome: 'client_disconnected' })).toBe(disconnects + 1);
    expect(await metricValue('sse_streams_total', { outcome: 'timeout' })).toBe(timeouts + 1);
    expect(await metricValue('sse_streams_active')).toBe(base);
  });
});

describe('Database metrics', () => {
  test('queries are timed by SQL operation, errors counted, SQL text never used', async () => {
    const selects = await metricValue('db_query_duration_seconds_count', { operation: 'select' });
    const errors = await metricValue('db_query_errors_total', { operation: 'select' });
    await pool.query('SELECT 1');
    await expect(pool.query('SELECT * FROM table_that_does_not_exist_obs')).rejects.toThrow();
    expect(await metricValue('db_query_duration_seconds_count', { operation: 'select' })).toBe(selects + 2);
    expect(await metricValue('db_query_errors_total', { operation: 'select' })).toBe(errors + 1);

    expect(sqlOperation('  UPDATE documents SET x = 1')).toBe('update');
    expect(sqlOperation({ text: 'insert into t values ($1)' })).toBe('insert');
    expect(sqlOperation("SELECT set_config('app.current_tenant', $1, true)")).toBe('select');
    expect(sqlOperation('VACUUM')).toBe('other');
  });

  test('pool gauges report total / idle / waiting connections', async () => {
    const text = await require('../../src/observability/metrics').register.getSingleMetricAsString('db_pool_connections');
    expect(text).toMatch(/state="total"/);
    expect(text).toMatch(/state="idle"/);
    expect(text).toMatch(/state="waiting"/);
  });
});
