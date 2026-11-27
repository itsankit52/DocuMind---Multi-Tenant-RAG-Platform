/**
 * Phase 3.3 WP1 (F8.2) — the error handler's 5xx structured log line is redacted.
 *
 * Before: logger.error('Request failed', { error: err, stack }) passed the raw message and stack;
 * the global logger scrubs URL credentials, bearer tokens and JWTs but not emails, so an address
 * in a 500 error reached the logs although the HTTP response was safe. Now the message and stack
 * go through redactForClient. Synthetic data only; no database or Redis access.
 */

const express = require('express');
const supertest = require('supertest');
const logger = require('../../src/observability/logger');
const { createErrorHandler } = require('../../src/middleware/error-handler');
const AppError = require('../../src/utils/AppError');

const EMAIL_A = 'jane.doe@example.com';
const EMAIL_B = 'OPS+Alerts@Mail.EU.Example.ORG';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ3cDEifQ.c2lnbmF0dXJlLXdwMS1zeW50aGV0aWM';
const INVITE_TOKEN = 'Wp1-abcdefghijklmnopqrstuvwxyz0123456789ABC';
const HASH = 'b'.repeat(64);
const SECRETS = [EMAIL_A, EMAIL_B, 'Hunter2-wp1', 's3cr3t-wp1', JWT, INVITE_TOKEN, HASH, 'p4ss-wp1'];
const MESSAGE =
  `lookup for ${EMAIL_A} and ${EMAIL_B} failed; password=Hunter2-wp1 secret: s3cr3t-wp1 ` +
  `Bearer ${JWT} token ${INVITE_TOKEN} hash ${HASH} via postgres://u1:p4ss-wp1@db.example.test:5432/x end`;
const CAUSE_TEXT = `driver says duplicate key (email)=(${EMAIL_A}) cause-only-marker`;

let lines;
beforeEach(() => {
  lines = [];
  logger.configure({ level: 'debug', write: (l) => lines.push(l) });
});
afterAll(() => logger.configure({ level: 'silent' }));

function appThrowing(makeError, developmentDiagnostics = false) {
  const app = express();
  app.use((req, _res, next) => { req.requestId = 'req-wp1-0001'; next(); });
  app.get('/boom', () => { throw makeError(); });
  app.use(createErrorHandler({ developmentDiagnostics }));
  return app;
}
const programmerError = () => {
  const e = new Error(MESSAGE, { cause: Object.assign(new Error(CAUSE_TEXT), { code: '23505' }) });
  e.code = 'E_WP1';
  return e;
};
const failedEntry = () => lines.map(l => JSON.parse(l)).find(e => e.message === 'Request failed');

describe('5xx log line', () => {
  test('message: every email redacted, surrounding text preserved, other secrets redacted', async () => {
    await supertest(appThrowing(programmerError)).get('/boom');
    const { error } = failedEntry();
    expect(error.message.startsWith('lookup for [REDACTED_EMAIL] and [REDACTED_EMAIL] failed;')).toBe(true);
    expect(error.message).toContain('password=[REDACTED]');
    expect(error.message).toContain('secret: [REDACTED]');
    expect(error.message).toContain('Bearer [REDACTED]');
    expect(error.message).toContain('[REDACTED_TOKEN]');
    expect(error.message).toContain('[REDACTED_HASH]');
    expect(error.message).toContain('postgres://***:***@');
    expect(error.message.endsWith(' end')).toBe(true);
  });

  test('no original secret or email in ANY field of the captured log output; cause never logged', async () => {
    await supertest(appThrowing(programmerError)).get('/boom');
    const raw = lines.join('\n');
    for (const s of SECRETS) expect(raw).not.toContain(s);
    expect(raw.toLowerCase()).not.toContain(EMAIL_B.toLowerCase());
    expect(raw).not.toContain('cause-only-marker');
    expect(raw).not.toContain('23505'); // the cause's code is not logged either
  });

  test('stack is logged for programmer errors, redacted but still a usable stack', async () => {
    await supertest(appThrowing(programmerError)).get('/boom');
    const { stack } = failedEntry();
    expect(stack).toContain('[REDACTED_EMAIL]');
    expect(stack).toMatch(/\n\s+at /);
    expect(stack.split('\n').length).toBeLessThanOrEqual(8);
  });

  test('request ID, method, status, error type and code remain available', async () => {
    await supertest(appThrowing(programmerError)).get('/boom');
    const entry = failedEntry();
    expect(entry).toMatchObject({ level: 'error', requestId: 'req-wp1-0001', method: 'GET', statusCode: 500 });
    expect(entry.error).toEqual({ type: 'Error', message: expect.any(String), code: 'E_WP1' });
  });

  test('operational 5xx: redacted message, no stack', async () => {
    await supertest(appThrowing(() => new AppError(`upstream unavailable for ${EMAIL_A}`, 503))).get('/boom');
    const entry = failedEntry();
    expect(entry.error.message).toBe('upstream unavailable for [REDACTED_EMAIL]');
    expect(entry).not.toHaveProperty('stack');
  });

  test('4xx errors are still not logged by the handler', async () => {
    await supertest(appThrowing(() => new AppError(`no invite for ${EMAIL_A}`, 404))).get('/boom');
    expect(failedEntry()).toBeUndefined();
  });
});

describe('HTTP responses unchanged', () => {
  test('production/test: generic body, same shape', async () => {
    const res = await supertest(appThrowing(programmerError)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ status: 'error', message: 'Something went wrong!' });
  });

  test('operational errors keep their message and code in the response', async () => {
    const res = await supertest(appThrowing(() => new AppError('Service temporarily unavailable.', 503))).get('/boom');
    expect(res.body).toEqual({ status: 'error', message: 'Service temporarily unavailable.' });
  });

  test('development diagnostics: same fields as before, redacted', async () => {
    const res = await supertest(appThrowing(programmerError, true)).get('/boom');
    expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'stack', 'status']);
    expect(res.body.error).toEqual({ type: 'Error', statusCode: 500, isOperational: false, causeType: 'Error', causeCode: '23505' });
    for (const s of SECRETS) expect(res.text).not.toContain(s);
    expect(res.text).not.toContain('cause-only-marker');
  });
});
