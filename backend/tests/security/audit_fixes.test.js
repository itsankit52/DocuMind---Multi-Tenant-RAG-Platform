/**
 * Regression tests for defects found in the 2026-09-27 project audit:
 *  - zod v4 validation errors (previously a TypeError text leaked to clients)
 *  - raw DB error text leaking through AppError
 *  - malformed X-Organization-Id -> 400 (was 500)
 *  - suspended organizations are no longer accessible
 *  - case-insensitive email login
 *  - conversation rename/delete limited to owner or admin
 *  - stale 'processing' jobs can be reclaimed; stage updates keep error_log
 *  - outbox relay republishes events whose direct publish never happened
 *  - readiness no longer requires Ollama
 */

const supertest = require('supertest');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const jobRepo = require('../../src/repositories/job.repository');
const outboxRepo = require('../../src/repositories/outbox.repository');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const { relayPendingOutbox } = require('../../src/queue/outbox.relay');
const { DEFAULT_CHECKS } = require('../../src/observability/health');
const h = require('../streaming/stream.helpers');

const request = supertest(app);
const q = { query: (text, values) => pool.query(text, values) };

let org;

beforeAll(async () => {
  await h.truncateAll();
  // Other suites share the per-IP auth limiter budget; start from a clean window.
  const redis = require('../../src/middleware/rate-limiter').getRedisClient();
  if (!redis.isOpen) await redis.connect();
  const keys = await redis.keys('ratelimit:auth:*');
  if (keys.length) await redis.del(keys);
  org = await h.createOrgWithUsers('audit-fixes', ['admin', 'member', 'viewer']);
});

afterAll(async () => {
  await h.truncateAll();
  await rabbitmqService.close().catch(() => {});
  await pool.end();
});

const as = (role) => h.requestWithAuth(org.users[role].token, org.orgId);

describe('Validation and error handling', () => {
  test('register with invalid input returns the zod messages, not a TypeError', async () => {
    const res = await request.post('/api/auth/register').send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Please provide a valid email address');
    expect(res.body.message).toContain('Password must be at least 8 characters long');
    expect(res.body.message).not.toMatch(/Cannot read properties/);
  });

  test('login with invalid body returns 400 with a validation message', async () => {
    const res = await request.post('/api/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Please provide a valid email address');
  });

  test('over-long passwords are rejected before hashing', async () => {
    const res = await request.post('/api/auth/register')
      .send({ email: 'long@documind.test', password: 'a'.repeat(129) });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at most 128');
  });

  test('email is matched case-insensitively and duplicates by case are refused', async () => {
    const reg = await request.post('/api/auth/register')
      .send({ email: 'Mixed.Case@DocuMind.test', password: 'Password123!' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.email).toBe('mixed.case@documind.test');

    const dup = await request.post('/api/auth/register')
      .send({ email: 'mixed.case@documind.test', password: 'Password123!' });
    expect(dup.status).toBe(400);

    const login = await request.post('/api/auth/login')
      .send({ email: 'MIXED.CASE@documind.test', password: 'Password123!' });
    expect(login.status).toBe(200);
  });

  test('create-org validation error is a clean 400', async () => {
    const res = await supertest(app).post('/api/organizations')
      .set('Authorization', `Bearer ${org.users.admin.token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).not.toMatch(/Cannot read properties/);
  });

  test('malformed X-Organization-Id is a 400, not a 500', async () => {
    const res = await h.requestWithAuth(org.users.admin.token, 'not-a-uuid').get('/api/documents');
    expect(res.status).toBe(400);
  });
});

describe('Organization status', () => {
  test('a suspended organization is no longer accessible to its members', async () => {
    const other = await h.createOrgWithUsers('audit-suspended', ['admin']);
    const before = await h.requestWithAuth(other.users.admin.token, other.orgId).get('/api/documents');
    expect(before.status).toBe(200);

    await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [other.orgId]);
    const after = await h.requestWithAuth(other.users.admin.token, other.orgId).get('/api/documents');
    expect(after.status).toBe(403);
  });
});

describe('Conversation modification rights', () => {
  let adminConvId;

  beforeAll(async () => {
    const res = await as('admin').post('/api/conversations').send({ title: 'Admin conversation' });
    adminConvId = res.body.data.conversation.id;
  });

  test('a member cannot rename or delete a conversation they do not own', async () => {
    const rename = await supertest(app).patch(`/api/conversations/${adminConvId}`)
      .set('Authorization', `Bearer ${org.users.member.token}`).set('X-Organization-Id', org.orgId)
      .send({ title: 'hijacked' });
    expect(rename.status).toBe(403);

    const del = await supertest(app).delete(`/api/conversations/${adminConvId}`)
      .set('Authorization', `Bearer ${org.users.member.token}`).set('X-Organization-Id', org.orgId);
    expect(del.status).toBe(403);

    const { rows } = await pool.query('SELECT title, deleted_at FROM conversations WHERE id = $1', [adminConvId]);
    expect(rows[0].title).toBe('Admin conversation');
    expect(rows[0].deleted_at).toBeNull();
  });

  test('an admin can delete a member-owned conversation', async () => {
    const created = await as('member').post('/api/conversations').send({ title: 'Member conversation' });
    const id = created.body.data.conversation.id;
    const del = await supertest(app).delete(`/api/conversations/${id}`)
      .set('Authorization', `Bearer ${org.users.admin.token}`).set('X-Organization-Id', org.orgId);
    expect(del.status).toBe(200);
  });

  test('unknown conversation id is still a 404 for a member', async () => {
    const res = await supertest(app).delete('/api/conversations/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${org.users.member.token}`).set('X-Organization-Id', org.orgId);
    expect(res.status).toBe(404);
  });
});

describe('Processing job recovery', () => {
  async function insertJob(status, lockedMinutesAgo) {
    const { rows: [doc] } = await pool.query(
      `INSERT INTO documents (organization_id, filename, original_name, mime_type, file_size, storage_key, uploaded_by, status)
       VALUES ($1, 'r.pdf', 'r.pdf', 'application/pdf', 1, $2, $3, 'processing') RETURNING id`,
      [org.orgId, `k-${Date.now()}-${Math.random()}`, org.users.admin.id],
    );
    const { rows: [job] } = await pool.query(
      `INSERT INTO document_processing_jobs (organization_id, document_id, stage, status, locked_at, error_log)
       VALUES ($1, $2, 'extraction', $3, now() - make_interval(mins => $4::int), 'earlier failure') RETURNING *`,
      [org.orgId, doc.id, status, lockedMinutesAgo],
    );
    return job;
  }

  test('a processing job with an expired lock can be reclaimed', async () => {
    const job = await insertJob('processing', 120);
    const claimed = await jobRepo.claimJob(q, job.id, 'worker-recovery');
    expect(claimed).not.toBeNull();
    expect(claimed.worker_id).toBe('worker-recovery');
  });

  test('a processing job with a fresh lock is not stolen', async () => {
    const job = await insertJob('processing', 0);
    expect(await jobRepo.claimJob(q, job.id, 'worker-thief')).toBeNull();
  });

  test('stage-only updates keep the previous error_log', async () => {
    const job = await insertJob('retrying', 0);
    const updated = await jobRepo.updateJobStatus(q, job.id, { stage: 'embedding' });
    expect(updated.error_log).toBe('earlier failure');
  });
});

describe('Outbox relay', () => {
  test('republishes an old pending event and marks it published', async () => {
    const payload = { event: 'document.process', jobId: '00000000-0000-4000-8000-000000000001', documentId: 'x', organizationId: org.orgId };
    const event = await outboxRepo.createEvent(q, {
      organizationId: org.orgId, aggregateType: 'document', aggregateId: org.orgId,
      eventType: 'document.process', payload,
    });
    await pool.query("UPDATE outbox_events SET created_at = now() - interval '5 minutes' WHERE id = $1", [event.id]);

    const publishSpy = jest.spyOn(rabbitmqService, 'publish').mockResolvedValue(true);
    try {
      const count = await relayPendingOutbox({ minAgeSeconds: 30 });
      expect(count).toBeGreaterThanOrEqual(1);
      expect(publishSpy).toHaveBeenCalledWith(payload);
    } finally {
      publishSpy.mockRestore();
    }
    const { rows } = await pool.query('SELECT status FROM outbox_events WHERE id = $1', [event.id]);
    expect(rows[0].status).toBe('published');
  });

  test('keeps events pending when the broker is unavailable', async () => {
    const event = await outboxRepo.createEvent(q, {
      organizationId: org.orgId, aggregateType: 'document', aggregateId: org.orgId,
      eventType: 'document.process', payload: { event: 'document.process' },
    });
    await pool.query("UPDATE outbox_events SET created_at = now() - interval '5 minutes' WHERE id = $1", [event.id]);

    const publishSpy = jest.spyOn(rabbitmqService, 'publish').mockRejectedValue(new Error('broker down'));
    try {
      expect(await relayPendingOutbox({ minAgeSeconds: 30 })).toBe(0);
    } finally {
      publishSpy.mockRestore();
    }
    const { rows } = await pool.query('SELECT status FROM outbox_events WHERE id = $1', [event.id]);
    expect(rows[0].status).toBe('pending');
  });
});

describe('Readiness', () => {
  test('Ollama is an optional readiness dependency', () => {
    expect(DEFAULT_CHECKS.ollama.required).toBe(false);
    expect(DEFAULT_CHECKS.postgres.required).toBe(true);
  });
});
