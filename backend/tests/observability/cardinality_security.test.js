/**
 * Step 13 — mandatory checks: no high-cardinality / tenant-identifying labels and no
 * sensitive data in the metrics output. Traffic is generated with realistic identifiers
 * first, then the whole registry is inspected. No database rows are created or truncated.
 */

const supertest = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { register, FORBIDDEN_LABELS } = require('../../src/observability/metrics');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const { pool } = require('../../src/db');

const request = supertest(app);

const IDS = {
  org: '0190f7a2-aaaa-7000-8000-00000000a001',
  doc: '0190f7a2-bbbb-7000-8000-00000000b002',
  conv: '0190f7a2-cccc-7000-8000-00000000c003',
  msg: '0190f7a2-dddd-7000-8000-00000000d004',
  req: 'trace-req-5f2a9e',
};
const EMAIL = 'cardinality-check@documind.test';
const PASSWORD = 'Cardinality-Secret-99!';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;

let metricsJson;
let metricsText;

beforeAll(async () => {
  const withIds = (r) => r.set('X-Organization-Id', IDS.org).set('X-Request-Id', IDS.req);
  await withIds(request.get(`/api/documents/${IDS.doc}`));
  await withIds(request.get(`/api/documents/${IDS.doc}/download`));
  await withIds(request.get(`/api/conversations/${IDS.conv}/messages`));
  await withIds(request.post(`/api/conversations/${IDS.conv}/messages/stream`).send({ content: 'secret question' }));
  await withIds(request.post('/api/rag/query').send({ question: 'What is the salary of the CEO?' }));
  await request.get(`/unknown/${IDS.msg}/${EMAIL}`);
  await request.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
  await request.get('/health/ready');
  metricsJson = await register.getMetricsAsJSON();
  metricsText = (await request.get('/metrics')).text;
  await require('../../src/queue/rabbitmq.service').close();
});

afterAll(async () => {
  const redis = getRedisClient();
  if (redis && redis.isOpen) await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
});

describe('Metric cardinality', () => {
  test('no metric declares a forbidden (per-entity) label', () => {
    const offenders = [];
    for (const metric of metricsJson) {
      for (const value of metric.values) {
        for (const key of Object.keys(value.labels || {})) {
          if (FORBIDDEN_LABELS.map(l => l.toLowerCase()).includes(key.toLowerCase())) offenders.push(`${metric.name}{${key}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no label VALUE contains a UUID, email or request ID', () => {
    const offenders = [];
    for (const metric of metricsJson) {
      for (const value of metric.values) {
        for (const [key, labelValue] of Object.entries(value.labels || {})) {
          const v = String(labelValue);
          if (UUID_RE.test(v) || EMAIL_RE.test(v) || v.includes(IDS.req)) offenders.push(`${metric.name}{${key}="${v}"}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every label set is small and bounded', () => {
    const allowedKeys = new Set([
      'method', 'route', 'status_code', 'status', 'result', 'reason', 'operation', 'queue', 'outcome',
      'stage', 'mode', 'code', 'dependency', 'state', 'le', 'service',
      // prom-client default process / nodejs metrics
      'version', 'major', 'minor', 'patch', 'space', 'kind', 'type', 'quantile',
    ]);
    const unexpected = new Set();
    for (const metric of metricsJson) {
      for (const value of metric.values) {
        Object.keys(value.labels || {}).forEach(k => { if (!allowedKeys.has(k)) unexpected.add(`${metric.name}:${k}`); });
      }
    }
    expect([...unexpected]).toEqual([]);
  });

  test('HTTP route label values are route templates only', () => {
    const routes = new Set();
    for (const metric of metricsJson.filter(m => m.name === 'http_requests_total')) {
      metric.values.forEach(v => routes.add(v.labels.route));
    }
    for (const route of routes) {
      expect(route === 'unmatched' || /^\/[a-z/:*A-Z._-]*$/.test(route)).toBe(true);
    }
    expect(routes.has('unmatched')).toBe(true);
  });
});

describe('Sensitive data in metrics output', () => {
  test('metrics never contain identifiers, credentials, questions or secrets', () => {
    const forbidden = [
      IDS.org, IDS.doc, IDS.conv, IDS.msg, IDS.req, EMAIL, PASSWORD,
      'secret question', 'salary of the CEO',
      env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.DATABASE_URL, env.REDIS_URL,
      env.MINIO_SECRET_KEY, env.MINIO_ACCESS_KEY,
      env.RABBITMQ_URL,
    ].filter(v => typeof v === 'string' && v.length >= 6);
    for (const value of forbidden) {
      expect(metricsText).not.toContain(value);
    }
    expect(metricsText).not.toMatch(/eyJ[a-zA-Z0-9_-]{5,}\./); // JWTs
    expect(metricsText).not.toMatch(/:\/\/[^\s/@]+:[^\s/@]+@/); // URLs with credentials
  });

  test('readiness responses expose no hosts or credentials', async () => {
    const res = await request.get('/health/ready');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/localhost|127\.0\.0\.1|:\/\/|password|minioadmin|guest/i);
    await require('../../src/queue/rabbitmq.service').close();
  });
});
