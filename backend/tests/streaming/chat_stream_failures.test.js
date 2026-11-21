/**
 * Step 10 — Streaming failure paths, cancellation and concurrency
 *
 * Real PostgreSQL (RLS), real embeddings + Qdrant retrieval; the generation model is a
 * fake Ollama HTTP server so chunking, failures, slowness and aborts are deterministic.
 *
 * Covers: split network chunks end-to-end, event order, Ollama/Qdrant/embedding/PostgreSQL
 * failures, persistence failure, client disconnect + upstream abort, timeout, max response
 * size, graceful shutdown, heartbeat, concurrent cross-tenant stream isolation, no leakage.
 */

const http = require('http');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const app = require('../../src/app');
const minioService = require('../../src/storage/minio.service');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const qdrantService = require('../../src/vector/qdrant.service');
const embeddingService = require('../../src/embeddings/embedding.service');
const ollamaService = require('../../src/llm/ollama.service');
const chunkRepo = require('../../src/repositories/chunk.repository');
const citationRepo = require('../../src/repositories/citation.repository');
const DocumentProcessor = require('../../src/workers/processor');
const { streamRegistry } = require('../../src/sse/sse-session');
const { createTestPdf } = require('../fixtures/document.fixtures');
const h = require('./stream.helpers');

jest.setTimeout(90000);

let fake;
let orgA, orgB;
let docA, docB;
let convA, convB;
const originalBaseUrl = ollamaService.baseUrl;
const originalEnv = {
  CHAT_STREAM_TIMEOUT_MS: env.CHAT_STREAM_TIMEOUT_MS,
  MAX_STREAMED_RESPONSE_CHARS: env.MAX_STREAMED_RESPONSE_CHARS,
  SSE_HEARTBEAT_INTERVAL_MS: env.SSE_HEARTBEAT_INTERVAL_MS,
};

const streamA = (content, conv = convA) =>
  h.requestWithAuth(orgA.users.admin.token, orgA.orgId)
    .stream(`/api/conversations/${conv}/messages/stream`).send({ content });

const lastRequest = () => fake.requests[fake.requests.length - 1];
const answer = async (res, text) => {
  res.write(`${JSON.stringify({ response: text, done: false })}\n`);
  res.end(`${JSON.stringify({ response: '', done: true, done_reason: 'stop' })}\n`);
};

beforeAll(async () => {
  await minioService.ensureBucketExists();
  await rabbitmqService.connect();
  await qdrantService.ensureCollection(env.QDRANT_COLLECTION, env.EMBEDDING_DIMENSION);
  await h.truncateAll();

  orgA = await h.createOrgWithUsers('fail-org-a', ['admin']);
  orgB = await h.createOrgWithUsers('fail-org-b', ['admin']);
  const processor = new DocumentProcessor('test-stream-fail-worker');

  docA = await h.uploadAndProcess({
    token: orgA.users.admin.token, orgId: orgA.orgId, processor, filename: 'alpha.pdf',
    pdf: await createTestPdf(['Alpha travel policy.', 'Travel reimbursement code is ALPHA-SECRET-111.']),
  });
  docB = await h.uploadAndProcess({
    token: orgB.users.admin.token, orgId: orgB.orgId, processor, filename: 'beta.pdf',
    pdf: await createTestPdf(['Beta travel policy.', 'Travel reimbursement code is BETA-SECRET-222.']),
  });

  const ca = await h.requestWithAuth(orgA.users.admin.token, orgA.orgId).post('/api/conversations').send({});
  const cb = await h.requestWithAuth(orgB.users.admin.token, orgB.orgId).post('/api/conversations').send({});
  convA = ca.body.data.conversation.id;
  convB = cb.body.data.conversation.id;

  fake = await h.startFakeOllama();
  ollamaService.baseUrl = fake.url;
});

beforeEach(async () => {
  await h.resetChatRateLimit(orgA.orgId, orgA.users.admin.id);
  await h.resetChatRateLimit(orgB.orgId, orgB.users.admin.id);
});

afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env, originalEnv);
  ollamaService.baseUrl = fake.url;
  streamRegistry._reset();
});

afterAll(async () => {
  ollamaService.baseUrl = originalBaseUrl;
  await fake.close();
  try { await rabbitmqService.close(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
});

/** Assert a failed stream: start, token*, exactly one error last, no done, nothing persisted. */
async function expectFailedStream(res, code) {
  expect(res.status).toBe(200);
  const events = h.parseSseEvents(res.body);
  expect(events[0].event).toBe('start');
  const last = events[events.length - 1];
  expect(last).toEqual({ event: 'error', data: { code, message: expect.any(String) } });
  expect(events.filter(e => e.event === 'error')).toHaveLength(1);
  expect(events.some(e => e.event === 'done')).toBe(false);
  expect(events.slice(1, -1).every(e => e.event === 'token')).toBe(true);
  expect(await h.assistantMessagesFor(events[0].data.userMessageId)).toHaveLength(0);
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('1. Split network chunks end-to-end and event order', () => {
  it('reassembles split/merged NDJSON into tokens and persists the exact streamed text', async () => {
    fake.handler = async (req, res) => {
      const parts = ['{"response":"Reimbursement ', 'code","done":false}\n{"response":" is", "done":false}\n',
        'not json\n{"response":" ALPHA-SECRET-111.","done":false}\n{"response":"","done":tr', 'ue,"done_reason":"stop"}\n'];
      for (const p of parts) { res.write(p); await h.sleep(15); }
      res.end();
    };
    const res = await streamA('What is the travel reimbursement code?');
    const events = h.parseSseEvents(res.body);
    const names = events.map(e => e.event);

    // START TOKEN* CITATION* DONE — exactly one done, last, nothing after
    expect(names[0]).toBe('start');
    expect(names[names.length - 1]).toBe('done');
    expect(names.filter(n => n === 'done')).toHaveLength(1);
    const firstCitation = names.indexOf('citation');
    expect(firstCitation).toBeGreaterThan(0);
    expect(names.slice(1, firstCitation).every(n => n === 'token')).toBe(true);
    expect(names.slice(firstCitation, -1).every(n => n === 'citation')).toBe(true);

    const text = events.filter(e => e.event === 'token').map(e => e.data.text).join('');
    expect(text).toBe('Reimbursement code is ALPHA-SECRET-111.');

    const done = events[events.length - 1].data;
    const [assistant] = await h.assistantMessagesFor(events[0].data.userMessageId);
    expect(assistant.id).toBe(done.messageId);
    expect(assistant.content).toBe(text);
    const { rows: cits } = await pool.query('SELECT * FROM citations WHERE message_id = $1', [assistant.id]);
    expect(cits.length).toBe(events.filter(e => e.event === 'citation').length);
    expect(cits.every(c => c.document_id === docA.id)).toBe(true);
  });

  it('sends heartbeat comments during slow generation', async () => {
    env.SSE_HEARTBEAT_INTERVAL_MS = 30;
    fake.handler = async (req, res) => { await h.sleep(200); await answer(res, 'ok'); };
    const res = await streamA('What is the travel reimbursement code?');
    expect(res.body).toContain(': heartbeat\n\n');
    expect(h.parseSseEvents(res.body).pop().event).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. Upstream failures produce one safe error event and persist nothing', () => {
  const SECRET_DETAIL = 'internal-test-detail';

  it('Ollama HTTP error → LLM_STREAM_ERROR (raw error not forwarded)', async () => {
    fake.handler = async (req, res) => { res.statusCode = 500; res.end(`{"error":"${SECRET_DETAIL}"}`); };
    const res = await streamA('What is the travel reimbursement code?');
    await expectFailedStream(res, 'LLM_STREAM_ERROR');
    expect(res.body).not.toContain(SECRET_DETAIL);
  });

  it('Ollama error mid-stream → START, TOKEN*, ERROR (no DONE)', async () => {
    fake.handler = async (req, res) => {
      res.write('{"response":"Partial","done":false}\n');
      await h.sleep(20);
      res.end(`{"error":"${SECRET_DETAIL}"}\n`);
    };
    const res = await streamA('What is the travel reimbursement code?');
    const events = await expectFailedStream(res, 'LLM_STREAM_ERROR');
    expect(events.some(e => e.event === 'token')).toBe(true);
    expect(res.body).not.toContain(SECRET_DETAIL);
  });

  it('Ollama unreachable → LLM_STREAM_ERROR without internal URL', async () => {
    ollamaService.baseUrl = 'http://127.0.0.1:1';
    const res = await streamA('What is the travel reimbursement code?');
    await expectFailedStream(res, 'LLM_STREAM_ERROR');
    expect(res.body).not.toContain('127.0.0.1');
  });

  it('Qdrant failure → RETRIEVAL_ERROR', async () => {
    jest.spyOn(qdrantService, 'searchPoints').mockRejectedValue(new Error(`qdrant ${env.QDRANT_URL} ${SECRET_DETAIL}`));
    const res = await streamA('What is the travel reimbursement code?');
    await expectFailedStream(res, 'RETRIEVAL_ERROR');
    expect(res.body).not.toContain(SECRET_DETAIL);
    expect(res.body).not.toContain(env.QDRANT_URL);
  });

  it('Embedding failure → RETRIEVAL_ERROR', async () => {
    jest.spyOn(embeddingService, 'embedText').mockRejectedValue(new Error(SECRET_DETAIL));
    const res = await streamA('What is the travel reimbursement code?');
    await expectFailedStream(res, 'RETRIEVAL_ERROR');
    expect(res.body).not.toContain(SECRET_DETAIL);
  });

  it('PostgreSQL failure during RLS verification → RETRIEVAL_ERROR', async () => {
    jest.spyOn(chunkRepo, 'findChunksWithDocumentByIds').mockRejectedValue(new Error(`relation error ${SECRET_DETAIL}`));
    const res = await streamA('What is the travel reimbursement code?');
    await expectFailedStream(res, 'RETRIEVAL_ERROR');
    expect(res.body).not.toContain(SECRET_DETAIL);
  });

  it('PostgreSQL failure while persisting citations → PERSISTENCE_ERROR, assistant message rolled back', async () => {
    fake.handler = async (req, res) => answer(res, 'The code is ALPHA-SECRET-111.');
    jest.spyOn(citationRepo, 'createCitations').mockRejectedValue(new Error(`insert failed ${SECRET_DETAIL}`));
    const res = await streamA('What is the travel reimbursement code?');
    const events = await expectFailedStream(res, 'PERSISTENCE_ERROR');
    expect(events.some(e => e.event === 'citation')).toBe(false);
    expect(res.body).not.toContain(SECRET_DETAIL);
    await h.waitFor(async () => (await h.auditActions(convA)).some(a => a.action === 'CHAT_STREAM_FAILED'
      && a.metadata.userMessageId === events[0].data.userMessageId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3. Cancellation, timeout, size limit and shutdown', () => {
  it('client disconnect aborts the upstream Ollama request and persists nothing', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    fake.handler = async (req, res) => h.writeSlowTokens(res, { delayMs: 25, text: 'y' });
    const requestsBefore = fake.requests.length;

    try {
      const userMessageId = await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST',
          path: `/api/conversations/${convA}/messages/stream`,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${orgA.users.admin.token}`,
            'X-Organization-Id': orgA.orgId,
          },
        }, (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
            if (!settled && raw.includes('event: token')) {
              settled = true;
              clearTimeout(timer);
              const start = h.parseSseEvents(raw.slice(0, raw.indexOf('\n\n') + 2))[0];
              req.destroy(); // client goes away mid-generation
              resolve(start.data.userMessageId);
            }
          });
        });
        req.on('error', () => {});
        req.end(JSON.stringify({ content: 'What is the travel reimbursement code?' }));
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          req.destroy();
          reject(new Error('no token received'));
        }, 20000);
      });

      const record = fake.requests[requestsBefore];
      expect(await h.waitFor(() => record.aborted, 5000)).toBe(true);
      expect(await h.waitFor(() => streamRegistry.activeCount() === 0, 5000)).toBe(true);
      expect(await h.waitFor(async () => (await h.auditActions(convA))
        .some(a => a.action === 'CHAT_STREAM_CANCELLED' && a.metadata.userMessageId === userMessageId))).toBe(true);
      expect(await h.assistantMessagesFor(userMessageId)).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  });

  it('timeout aborts Ollama, sends STREAM_TIMEOUT and persists nothing', async () => {
    env.CHAT_STREAM_TIMEOUT_MS = 400;
    fake.handler = async (req, res) => h.writeSlowTokens(res, { delayMs: 50 });
    const res = await streamA('What is the travel reimbursement code?');
    const events = await expectFailedStream(res, 'STREAM_TIMEOUT');
    expect(await h.waitFor(() => lastRequest().aborted, 3000)).toBe(true);
    expect(await h.waitFor(async () => (await h.auditActions(convA)).some(a => a.action === 'CHAT_STREAM_FAILED'
      && a.metadata.code === 'STREAM_TIMEOUT' && a.metadata.userMessageId === events[0].data.userMessageId))).toBe(true);
  });

  it('timeout also bounds a hung retrieval stage', async () => {
    env.CHAT_STREAM_TIMEOUT_MS = 300;
    jest.spyOn(embeddingService, 'embedText').mockImplementation(() => new Promise(() => {}));
    const res = await streamA('What is the travel reimbursement code?');
    await expectFailedStream(res, 'STREAM_TIMEOUT');
  });

  it('exceeding MAX_STREAMED_RESPONSE_CHARS stops generation without persisting a truncated answer', async () => {
    env.MAX_STREAMED_RESPONSE_CHARS = 20;
    fake.handler = async (req, res) => h.writeSlowTokens(res, { delayMs: 10, text: 'abcd' });
    const res = await streamA('What is the travel reimbursement code?');
    const events = await expectFailedStream(res, 'RESPONSE_TOO_LARGE');
    const streamed = events.filter(e => e.event === 'token').map(e => e.data.text).join('');
    expect(streamed.length).toBeLessThanOrEqual(20);
    expect(await h.waitFor(() => lastRequest().aborted, 3000)).toBe(true);
  });

  it('graceful shutdown aborts active streams and rejects new ones with 503', async () => {
    fake.handler = async (req, res) => h.writeSlowTokens(res, { delayMs: 25 });
    const pending = streamA('What is the travel reimbursement code?');
    const inflight = new Promise(r => pending.then(r));
    await h.waitFor(() => streamRegistry.activeCount() === 1 && fake.requests.length > 0 && !lastRequest().aborted, 20000);
    await h.sleep(100);
    streamRegistry.beginShutdown();
    const res = await inflight;
    await expectFailedStream(res, 'SERVER_SHUTTING_DOWN');
    expect(await h.waitFor(() => lastRequest().aborted, 3000)).toBe(true);

    const rejected = await h.requestWithAuth(orgA.users.admin.token, orgA.orgId)
      .post(`/api/conversations/${convA}/messages/stream`).send({ content: 'new stream' });
    expect(rejected.status).toBe(503);
    expect(rejected.headers['content-type']).toContain('application/json');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. Concurrent streams stay isolated per request and per tenant', () => {
  it('interleaved Org A and Org B streams never cross tokens, citations or context', async () => {
    const searchSpy = jest.spyOn(qdrantService, 'searchPoints');
    // Fake model echoes whichever tenant secret is present in ITS prompt, char by char
    fake.handler = async (req, res, body) => {
      const secret = (body.prompt.match(/(ALPHA|BETA)-SECRET-\d+/) || ['NONE'])[0];
      for (const ch of secret) {
        res.write(`${JSON.stringify({ response: ch, done: false })}\n`);
        await h.sleep(15);
      }
      res.end(`${JSON.stringify({ response: '', done: true, done_reason: 'stop' })}\n`);
    };

    const [resA, resB, resA2] = await Promise.all([
      streamA('What is the travel reimbursement code?'),
      h.requestWithAuth(orgB.users.admin.token, orgB.orgId)
        .stream(`/api/conversations/${convB}/messages/stream`)
        .send({ content: 'What is the travel reimbursement code?', organizationId: orgA.orgId }),
      streamA('Tell me the travel reimbursement code.'),
    ]);

    for (const r of [resA, resB, resA2]) {
      expect(h.parseSseEvents(r.body).pop()).toMatchObject({ event: 'done', data: { finishReason: 'stop' } });
    }
    const textOf = (r) => h.parseSseEvents(r.body).filter(e => e.event === 'token').map(e => e.data.text).join('');
    expect(textOf(resA)).toBe('ALPHA-SECRET-111');
    expect(textOf(resA2)).toBe('ALPHA-SECRET-111');
    expect(textOf(resB)).toBe('BETA-SECRET-222');
    expect(resB.body).not.toContain('ALPHA');
    expect(resA.body).not.toContain('BETA');

    const citationsOf = (r) => h.parseSseEvents(r.body).filter(e => e.event === 'citation').map(e => e.data.documentId);
    expect(citationsOf(resA).every(id => id === docA.id)).toBe(true);
    expect(citationsOf(resB).every(id => id === docB.id)).toBe(true);
    expect(citationsOf(resB).length).toBeGreaterThan(0);

    // Qdrant tenant filter used the authenticated tenant, not the spoofed body organizationId
    const orgFilters = searchSpy.mock.calls.map(c => c[1].organizationId).sort();
    expect(orgFilters).toEqual([orgA.orgId, orgA.orgId, orgB.orgId].sort());

  });
});
