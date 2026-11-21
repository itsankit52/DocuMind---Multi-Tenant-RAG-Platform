/**
 * Step 13 — /metrics endpoint, HTTP metrics, correlation IDs, fail-safe recording.
 * No database rows are created or truncated by this suite.
 */

const express = require('express');
const supertest = require('supertest');
const app = require('../../src/app');
const env = require('../../src/config/env');
const { metrics, register } = require('../../src/observability/metrics');
const { requestContext, tagRoute, httpMetrics, routeLabel, isPrivateAddress } = require('../../src/observability/http');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const { pool } = require('../../src/db');
const { metricValue, invalidExpositionLines } = require('./obs.helpers');

const request = supertest(app);

afterAll(async () => {
  const redis = getRedisClient();
  if (redis && redis.isOpen) await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
});

describe('GET /metrics', () => {
  test('responds 200 with Prometheus text format', async () => {
    await request.get('/health');
    const res = await request.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/# TYPE http_requests_total counter/);
    expect(res.text).toMatch(/# TYPE http_request_duration_seconds histogram/);
    expect(invalidExpositionLines(res.text)).toEqual([]);
  });

  test('exposes every Step 13 metric family', async () => {
    const res = await request.get('/metrics');
    for (const name of [
      'http_requests_total', 'http_request_duration_seconds', 'rag_queries_total', 'rag_duration_seconds',
      'rag_retrieval_duration_seconds', 'embedding_requests_total', 'embedding_duration_seconds',
      'qdrant_requests_total', 'ollama_requests_total', 'sse_streams_total', 'sse_streams_active',
      'document_processing_jobs_total', 'document_processing_stage_duration_seconds', 'queue_depth',
      'db_query_duration_seconds', 'db_pool_connections', 'redis_errors_total', 'auth_login_attempts_total',
      'dependency_up',
    ]) {
      expect(res.text).toContain(`# TYPE ${name} `);
    }
  });

  test('requires the bearer token when METRICS_TOKEN is configured', async () => {
    const original = env.METRICS_TOKEN;
    env.METRICS_TOKEN = 'test-metrics-token-123';
    try {
      expect((await request.get('/metrics')).status).toBe(403);
      expect((await request.get('/metrics').set('Authorization', 'Bearer wrong-token-xxxxxxx')).status).toBe(403);
      expect((await request.get('/metrics').set('Authorization', 'Bearer test-metrics-token-123')).status).toBe(200);
    } finally {
      env.METRICS_TOKEN = original;
    }
  });

  test('returns 404 when metrics are disabled', async () => {
    env.METRICS_ENABLED = false;
    try {
      expect((await request.get('/metrics')).status).toBe(404);
    } finally {
      env.METRICS_ENABLED = true;
    }
  });

  test('without a token only loopback / private addresses may scrape', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.65.1', 'fd00:abcd::1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '2001:db8::1', '']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});

describe('HTTP request metrics', () => {
  test('counts requests by method, route template and status', async () => {
    const labels = { method: 'GET', route: '/health', status_code: '200' };
    const before = await metricValue('http_requests_total', labels);
    await request.get('/health');
    await request.get('/health');
    expect(await metricValue('http_requests_total', labels)).toBe(before + 2);
    expect(await metricValue('http_request_duration_seconds_count', labels)).toBeGreaterThanOrEqual(before + 2);
  });

  test('uses the mount path for rejected requests, never the raw URL', async () => {
    const id = '0190f7a2-1111-7222-8333-944455556666';
    const labels = { method: 'GET', route: '/api/documents/*', status_code: '401' };
    const before = await metricValue('http_requests_total', labels);
    const deniedBefore = await metricValue('auth_denied_total', { reason: 'unauthorized' });
    const res = await request.get(`/api/documents/${id}`);
    expect(res.status).toBe(401);
    expect(await metricValue('http_requests_total', labels)).toBe(before + 1);
    expect(await metricValue('auth_denied_total', { reason: 'unauthorized' })).toBe(deniedBefore + 1);
    expect((await request.get('/metrics')).text).not.toContain(id);
  });

  test('unknown paths collapse into a single "unmatched" route', async () => {
    const before = await metricValue('http_requests_total', { route: 'unmatched', status_code: '404' });
    await request.get('/does-not-exist/abc123');
    await request.get('/another/random/path');
    expect(await metricValue('http_requests_total', { route: 'unmatched', status_code: '404' })).toBe(before + 2);
  });

  test('records failed logins by result without identifying the user', async () => {
    const before = await metricValue('auth_login_attempts_total');
    const res = await request.post('/api/auth/login').send({ email: 'nobody@documind.test', password: 'Wrong-password-1' });
    expect(res.status).toBeGreaterThanOrEqual(400); // 401, or 429 if the login limiter is exhausted
    expect(await metricValue('auth_login_attempts_total')).toBe(before + 1);
    const failedOrLimited = await metricValue('auth_login_attempts_total', { result: res.status === 429 ? 'rate_limited' : 'failure' });
    expect(failedOrLimited).toBeGreaterThanOrEqual(1);
    const { values } = await metrics.authLoginAttempts.get();
    expect(values.every(v => Object.keys(v.labels).every(k => k === 'result'))).toBe(true);
  });

  test('records 5xx responses and in-flight gauge returns to its baseline', async () => {
    const mini = express();
    mini.use(requestContext);
    mini.use(httpMetrics);
    mini.use('/boom', tagRoute, express.Router().get('/:id', () => { throw new Error('kaboom'); }));
    mini.use((err, req, res, next) => res.status(500).json({ status: 'error' })); // eslint-disable-line no-unused-vars

    const inFlight = await metricValue('http_requests_in_flight');
    const labels = { method: 'GET', route: '/boom/:id', status_code: '500' };
    const before = await metricValue('http_requests_total', labels);
    const res = await supertest(mini).get('/boom/42');
    expect(res.status).toBe(500);
    expect(await metricValue('http_requests_total', labels)).toBe(before + 1);
    expect(await metricValue('http_requests_in_flight')).toBe(inFlight);
  });

  test('routeLabel prefers templates and bounded fallbacks', () => {
    expect(routeLabel({ metricsBase: '/api/documents', route: { path: '/:documentId' } })).toBe('/api/documents/:documentId');
    expect(routeLabel({ metricsBase: '/api/documents', route: { path: '/' } })).toBe('/api/documents');
    expect(routeLabel({ metricsBase: '/api/rag' })).toBe('/api/rag/*');
    expect(routeLabel({})).toBe('unmatched');
  });
});

describe('Request correlation', () => {
  test('generates an X-Request-Id when none is supplied', async () => {
    const res = await request.get('/health/live');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('preserves a safe client-supplied X-Request-Id', async () => {
    const res = await request.get('/health/live').set('X-Request-Id', 'client-trace_01.abc');
    expect(res.headers['x-request-id']).toBe('client-trace_01.abc');
  });

  test('replaces an unsafe X-Request-Id (log / header injection)', async () => {
    const res = await request.get('/health/live').set('X-Request-Id', 'bad id {"level":"error"}');
    expect(res.headers['x-request-id']).not.toContain('bad id');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Observability failures never break requests', () => {
  test('a throwing metric does not affect the response', async () => {
    const original = metrics.httpRequestsTotal.inc;
    metrics.httpRequestsTotal.inc = () => { throw new Error('metrics backend exploded'); };
    try {
      const res = await request.get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    } finally {
      metrics.httpRequestsTotal.inc = original;
    }
  });

  test('a failing metrics collection returns 500 on /metrics only', async () => {
    const spy = jest.spyOn(register, 'metrics').mockRejectedValueOnce(new Error('collect failed'));
    const res = await request.get('/metrics');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('collect failed');
    spy.mockRestore();
    expect((await request.get('/health')).status).toBe(200);
  });
});
