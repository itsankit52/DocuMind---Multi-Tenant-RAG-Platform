/**
 * Shared helpers for Step 10 streaming tests (not a test suite itself).
 */

const supertest = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const { startFakeOllama, writeSlowTokens, waitFor, sleep } = require('./fake-ollama');

/** Parse a raw SSE body into [{ event, data }]. Comment lines (heartbeats) are skipped. */
function parseSseEvents(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const events = [];
  for (const block of rawText.split('\n\n')) {
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return events;
}

/** supertest parser that keeps the raw SSE text. */
const sseParser = (res, callback) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => callback(null, data));
};

const requestWithAuth = (token, orgId) => {
  const req = supertest(app);
  const auth = (r) => r.set('Authorization', `Bearer ${token}`).set('X-Organization-Id', orgId);
  return {
    get: (url) => auth(req.get(url)),
    post: (url) => auth(req.post(url)),
    stream: (url) => auth(req.post(url)).set('Accept', 'text/event-stream').buffer(true).parse(sseParser),
  };
};

/** Create an org with users per role ('removed' → inactive member). Returns { orgId, users: { role: { id, token } } }. */
async function createOrgWithUsers(slug, roles = ['admin']) {
  const hash = await argon2.hash('Password123!');
  const { rows } = await pool.query(
    'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
    [`Org ${slug}`, slug],
  );
  const orgId = rows[0].id;
  const users = {};
  for (const role of roles) {
    const u = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id',
      [`${slug}_${role}@documind.test`, hash, `${slug} ${role}`],
    );
    const id = u.rows[0].id;
    // 'removed' = a member whose membership is inactive
    await pool.query(
      'INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1,$2,$3,$4)',
      [orgId, id, role === 'removed' ? 'member' : role, role === 'removed' ? 'removed' : 'active'],
    );
    users[role] = { id, token: jwt.sign({ userId: id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) };
  }
  return { orgId, users };
}

async function truncateAll() {
  await pool.query(
    'TRUNCATE organizations, users, memberships, documents, document_processing_jobs, ' +
    'document_chunks, outbox_events, conversations, messages, citations, audit_logs CASCADE',
  );
}

/** Reset the shared chat rate-limit counter so long suites don't trip it. */
async function resetChatRateLimit(orgId, userId) {
  const client = getRedisClient();
  if (!client.isOpen) await client.connect();
  await client.del(`ratelimit:chat:${orgId}:${userId}`);
}

/** Upload a PDF and run it through the real processing + embedding pipeline. */
async function uploadAndProcess({ token, orgId, pdf, filename, processor }) {
  const res = await requestWithAuth(token, orgId).post('/api/documents').attach('file', pdf, filename);
  const doc = res.body.data.document;
  // Emulate the queue's retry: re-deliver the job if a transient failure left it unfinished
  for (let attempt = 1; attempt <= env.MAX_PROCESSING_ATTEMPTS; attempt++) {
    await processor.processJob(
      { event: 'document.process', jobId: doc.job.id, documentId: doc.id, organizationId: orgId },
      { ack: () => {}, nack: () => {}, retry: () => {} },
    );
    const { rows } = await pool.query('SELECT status FROM documents WHERE id = $1', [doc.id]);
    if (rows[0].status === 'ready') return doc;
    await sleep(500);
  }
  throw new Error(`Test document ${filename} failed to process`);
}

async function assistantMessagesFor(userMessageId) {
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE role = 'assistant' AND metadata->>'replyTo' = $1`,
    [userMessageId],
  );
  return rows;
}

async function auditActions(conversationId) {
  const { rows } = await pool.query(
    'SELECT action, metadata FROM audit_logs WHERE resource_id = $1 ORDER BY created_at ASC',
    [conversationId],
  );
  return rows;
}

module.exports = {
  startFakeOllama,
  writeSlowTokens,
  waitFor,
  sleep,
  parseSseEvents,
  sseParser,
  requestWithAuth,
  createOrgWithUsers,
  truncateAll,
  resetChatRateLimit,
  uploadAndProcess,
  assistantMessagesFor,
  auditActions,
};
