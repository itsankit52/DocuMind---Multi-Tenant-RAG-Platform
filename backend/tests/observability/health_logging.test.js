/**
 * Step 13 — liveness / readiness and structured, redacted logging.
 * No database rows are created or truncated by this suite.
 */

const express = require('express');
const supertest = require('supertest');
const app = require('../../src/app');
const logger = require('../../src/observability/logger');
const { createHealthRouter } = require('../../src/observability/health');
const { getRedisClient } = require('../../src/middleware/rate-limiter');
const { pool } = require('../../src/db');
const { metricValue, captureLogs } = require('./obs.helpers');

const request = supertest(app);

afterAll(async () => {
  const redis = getRedisClient();
  if (redis && redis.isOpen) await redis.quit().catch(() => {});
  await pool.end().catch(() => {});
});

function healthApp(checks, timeoutMs = 200) {
  const mini = express();
  mini.use('/health', createHealthRouter({ checks, timeoutMs }));
  return supertest(mini);
}
const up = (required = true) => ({ required, run: async () => {} });
const down = (required = true, message = 'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2') =>
  ({ required, run: async () => { throw new Error(message); } });

describe('Health endpoints', () => {
  test('GET /health keeps the Step 4 contract', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'healthy', service: 'documind-api', environment: 'test' }));
  });

  test('GET /health/live never depends on external services', async () => {
    const res = await healthApp({ postgres: down() }).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  test('GET /health/ready is 200 "ready" when every dependency is up', async () => {
    const res = await healthApp({ postgres: up(), qdrant: up(), redis: up(false) }).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.postgres).toEqual(expect.objectContaining({ status: 'up', required: true }));
    expect(await metricValue('dependency_up', { dependency: 'postgres' })).toBe(1);
  });

  test('a failing required dependency makes readiness 503 without leaking details', async () => {
    const res = await healthApp({ postgres: down(), qdrant: up() }).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.postgres.status).toBe('down');
    expect(res.body.checks.qdrant.status).toBe('up');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2/);
    expect(await metricValue('dependency_up', { dependency: 'postgres' })).toBe(0);
  });

  test('a failing optional dependency (Redis) reports "degraded" but stays ready', async () => {
    const res = await healthApp({ postgres: up(), redis: down(false) }).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });

  test('a hanging dependency check times out instead of hanging the probe', async () => {
    const hang = { required: true, run: () => new Promise(() => {}) };
    const started = Date.now();
    const res = await healthApp({ ollama: hang }, 100).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.ollama.status).toBe('down');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('the real /health/ready answers with all six dependencies', async () => {
    const res = await request.get('/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(Object.keys(res.body.checks).sort()).toEqual(['minio', 'ollama', 'postgres', 'qdrant', 'rabbitmq', 'redis']);
    await require('../../src/queue/rabbitmq.service').close();
  });
});

describe('Structured logging', () => {
  test('writes one JSON object per line with the standard fields', async () => {
    const lines = await captureLogs(async () => logger.info('worker started', { queue: 'main' }));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toEqual(expect.objectContaining({
      level: 'info', service: expect.any(String), environment: expect.any(String), message: 'worker started', queue: 'main',
    }));
    expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');
  });

  test('respects the configured level', async () => {
    const lines = await captureLogs(async () => {
      logger.debug('hidden');
      logger.warn('shown');
    }, 'warn');
    expect(lines.map(l => JSON.parse(l).message)).toEqual(['shown']);
  });

  test('attaches requestId / jobId from the async context', async () => {
    const lines = await captureLogs(async () => {
      await logger.runWithContext({ requestId: 'req-123' }, async () => {
        await new Promise(r => setTimeout(r, 5));
        logger.info('inside request');
        logger.runWithContext({ jobId: 'job-9' }, () => logger.info('inside job'));
      });
    });
    expect(JSON.parse(lines[0]).requestId).toBe('req-123');
    expect(JSON.parse(lines[1])).toEqual(expect.objectContaining({ requestId: 'req-123', jobId: 'job-9' }));
  });

  test('HTTP access logs carry the same requestId returned to the client', async () => {
    let res;
    const lines = await captureLogs(async () => {
      res = await request.get('/api/conversations').set('X-Request-Id', 'trace-abc-1');
    });
    const access = lines.map(l => JSON.parse(l)).find(e => e.message === 'HTTP request completed');
    expect(res.headers['x-request-id']).toBe('trace-abc-1');
    expect(access).toEqual(expect.objectContaining({
      requestId: 'trace-abc-1', method: 'GET', route: '/api/conversations/*', statusCode: 401,
    }));
    expect(typeof access.durationMs).toBe('number');
  });

  test('never logs passwords, tokens or credentials', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const lines = await captureLogs(async () => {
      await request.post('/api/auth/login')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ email: 'leak-check@documind.test', password: 'SuperSecret-Pa55word!' });
      logger.error(`connect failed amqp://guest:rabbitpass@localhost:5672 with Bearer ${jwt}`, {
        password: 'SuperSecret-Pa55word!',
        refreshToken: jwt,
        apiKey: 'qdrant-key-xyz',
        prompt: 'You are the DocuMind system prompt',
        content: 'CONFIDENTIAL document body',
        nested: { authorization: `Bearer ${jwt}`, databaseUrl: 'postgresql://admin:dbpass@db:5432/documind' },
      });
    });
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const secret of ['SuperSecret-Pa55word!', jwt, 'rabbitpass', 'dbpass', 'qdrant-key-xyz',
      'You are the DocuMind system prompt', 'CONFIDENTIAL document body']) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain('amqp://***:***@localhost:5672');
  });

  test('a broken log sink never throws into the caller', async () => {
    logger.configure({ level: 'info', write: () => { throw new Error('disk full'); } });
    try {
      expect(() => logger.error('still fine')).not.toThrow();
      const res = await request.get('/health');
      expect(res.status).toBe(200);
    } finally {
      logger.configure({ level: 'silent', write: (line) => process.stdout.write(`${line}\n`) });
    }
  });

  test('circular / unserializable fields do not throw', async () => {
    const circular = { a: 1 };
    circular.self = circular;
    const lines = await captureLogs(async () => logger.info('circular', { circular }));
    expect(lines).toHaveLength(1);
  });
});
