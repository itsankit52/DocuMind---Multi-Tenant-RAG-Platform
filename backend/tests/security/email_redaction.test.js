/**
 * Phase 3.2H (F8.1) — email redaction in error responses and rate-limiter logs.
 *
 * The email pattern in src/middleware/error-handler.js had an unescaped dot before the TLD
 * (`+.[A-Za-z]{2,}`): it matched any character there, so non-email text such as
 * "job@worker-queue in" was swallowed. The pattern now requires a literal dot. Synthetic
 * addresses only (example.test / example.com style); no database or real Redis access.
 */

const { EventEmitter } = require('events');
const express = require('express');
const supertest = require('supertest');
const { createErrorHandler, redactForClient } = require('../../src/middleware/error-handler');

const EMAILS = {
  standard: 'jane.doe@example.com',
  mixedCase: 'JANE.Doe@Example.COM',
  subdomain: 'ops+alerts@mail.eu.example.org',
  second: 'b_smith-99@corp.example.test',
};
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJmOCJ9.c2lnbmF0dXJlLWY4LXN5bnRoZXRpYw';
const INVITE_TOKEN = 'Tk_-abcdefghijklmnopqrstuvwxyz0123456789ABC';

describe('redactForClient — email pattern', () => {
  test.each(Object.entries(EMAILS))('%s address is redacted', (_label, email) => {
    const out = redactForClient(`lookup failed for ${email}`);
    expect(out).toBe('lookup failed for [REDACTED_EMAIL]');
  });

  test('multiple addresses in one message are each redacted, surrounding text kept', () => {
    const out = redactForClient(`from ${EMAILS.standard} to ${EMAILS.subdomain}, cc ${EMAILS.mixedCase} now`);
    expect(out).toBe('from [REDACTED_EMAIL] to [REDACTED_EMAIL], cc [REDACTED_EMAIL] now');
  });

  test.each([
    'retrying job@worker-queue in 5s',
    'ssh git@github_com failed',
    'deploy@build-server ok',
    'npm notice @scope/pkg@1.2.3',
    'ratio 3@4.5x',
    'user@localhost refused',
  ])('non-email text with punctuation is left alone: %p', (text) => {
    expect(redactForClient(text)).toBe(text);
  });

  test('text after an address is not swallowed (the old pattern ate the next word)', () => {
    expect(redactForClient(`contact ${EMAILS.standard} now`)).toBe('contact [REDACTED_EMAIL] now');
  });

  test('the other redactions still work alongside it', () => {
    const out = redactForClient(
      `user ${EMAILS.standard} password=Hunter2-synthetic secret: s3cr3t Bearer ${JWT} invite ${INVITE_TOKEN} ` +
      `hash ${'a'.repeat(64)} db postgres://u1:p4ss-synthetic@db.example.test:5432/x`,
    );
    for (const leaked of [EMAILS.standard, 'Hunter2-synthetic', 's3cr3t', JWT, INVITE_TOKEN, 'a'.repeat(64), 'p4ss-synthetic']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('password=[REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('[REDACTED_TOKEN]');
    expect(out).toContain('[REDACTED_HASH]');
    expect(out).toContain('postgres://***:***@');
  });
});

describe('error responses', () => {
  function appThrowing(message, developmentDiagnostics) {
    const app = express();
    app.get('/boom', () => { throw new Error(message); });
    app.use(createErrorHandler({ developmentDiagnostics }));
    return app;
  }
  const message = `no account for ${EMAILS.standard} or ${EMAILS.subdomain}`;

  test('development: emails are redacted in the message and in the stack', async () => {
    const res = await supertest(appThrowing(message, true)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('no account for [REDACTED_EMAIL] or [REDACTED_EMAIL]');
    expect(res.body.stack).toContain('[REDACTED_EMAIL]');
    expect(res.body.stack).toMatch(/\n\s+at /); // still a usable stack
    for (const email of Object.values(EMAILS)) expect(res.text).not.toContain(email);
  });

  test('production: the generic message only, no address anywhere', async () => {
    const res = await supertest(appThrowing(message, false)).get('/boom');
    expect(res.body).toEqual({ status: 'error', message: 'Something went wrong!' });
    for (const email of Object.values(EMAILS)) expect(res.text).not.toContain(email);
  });
});

describe('rate-limiter logs (they use the same redaction)', () => {
  test('an email in a Redis error never reaches the captured log line', async () => {
    const client = new EventEmitter();
    client.isOpen = true;
    client.connect = () => Promise.resolve();
    const chain = { set: () => chain, incr: () => chain, exec: () => Promise.reject(new Error(`AUTH failed for ${EMAILS.mixedCase} at ${EMAILS.second}`)) };
    client.multi = () => chain;
    let rateLimiter;
    let logger;
    jest.isolateModules(() => {
      jest.doMock('redis', () => ({ createClient: () => client }));
      logger = require('../../src/observability/logger');
      rateLimiter = require('../../src/middleware/rate-limiter');
    });
    const lines = [];
    logger.configure({ level: 'debug', write: (l) => lines.push(l) });
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      const app = express();
      app.get('/x', rateLimiter({ keyGenerator: () => 'ratelimit:f81:test' }), (req, res) => res.json({ ok: true }));
      expect((await supertest(app).get('/x')).status).toBe(200); // fail-open default unchanged
      const entry = lines.map(l => JSON.parse(l)).find(e => e.operation === 'rate_limit');
      expect(entry.error.message).toBe('AUTH failed for [REDACTED_EMAIL] at [REDACTED_EMAIL]');
      for (const email of Object.values(EMAILS)) expect(lines.join('\n')).not.toContain(email);
      // console stays unused (dotenv's own banner aside, printed when env.js is re-required)
      for (const spy of consoleSpies) {
        expect(spy.mock.calls.filter(args => !String(args[0]).includes('injected env'))).toEqual([]);
      }
    } finally {
      consoleSpies.forEach(s => s.mockRestore());
      jest.dontMock('redis');
    }
  });
});
