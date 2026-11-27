/**
 * Phase 2.1 — APP_BASE_URL validation (F3/F4).
 *
 * 1. The rules themselves (src/config/app-base-url.js), as a pure function.
 * 2. The real env.js wiring, by loading src/config/env.js in a child process with a
 *    controlled environment (env.js validates once at require time and exits on failure).
 * No database, Redis or network access.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { parseAppBaseUrl } = require('../../src/config/app-base-url');
const { buildInviteUrl } = require('../../src/invitations/invitation.service');
const env = require('../../src/config/env');

const BACKEND_DIR = path.join(__dirname, '..', '..');

describe('parseAppBaseUrl rules', () => {
  test.each(['development', 'test', 'production'])('unset and empty string are both "unset" (%s)', (nodeEnv) => {
    expect(parseAppBaseUrl(undefined, nodeEnv)).toEqual({ value: undefined, error: null });
    expect(parseAppBaseUrl('', nodeEnv)).toEqual({ value: undefined, error: null });
  });

  test.each([
    ['https://app.documind.test', 'https://app.documind.test'],
    ['https://app.documind.test/', 'https://app.documind.test'], // one trailing slash: same result
    ['https://APP.Documind.TEST', 'https://app.documind.test'], // host normalized to lowercase
    ['https://app.documind.test:443', 'https://app.documind.test'], // default port removed
    ['https://app.documind.test:8443/', 'https://app.documind.test:8443'],
  ])('production accepts %p as %p', (raw, expected) => {
    expect(parseAppBaseUrl(raw, 'production')).toEqual({ value: expected, error: null });
  });

  test.each([
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173'],
  ])('development/test accept local http origin %p', (raw, expected) => {
    expect(parseAppBaseUrl(raw, 'development')).toEqual({ value: expected, error: null });
    expect(parseAppBaseUrl(raw, 'test')).toEqual({ value: expected, error: null });
  });

  test.each([
    ['malformed', 'not a url'],
    ['scheme only', 'https://'],
    ['relative', '/invite'],
    ['non-http scheme', 'ftp://app.documind.test'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['credentials', 'https://user:pass@app.documind.test'],
    ['username only', 'https://user@app.documind.test'],
    ['path', 'https://app.documind.test/app'],
    ['double slash path', 'https://app.documind.test//'],
    ['query', 'https://app.documind.test?x=1'],
    ['empty query', 'https://app.documind.test/?'],
    ['fragment', 'https://app.documind.test#frag'],
    ['empty fragment', 'https://app.documind.test/#'],
    ['leading whitespace', ' https://app.documind.test'],
    ['trailing whitespace', 'https://app.documind.test '],
    ['whitespace only', '   '],
    ['backslash', 'https:\\\\app.documind.test'],
  ])('rejects %s (%p) in every environment', (_label, raw) => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      const result = parseAppBaseUrl(raw, nodeEnv);
      expect(result.value).toBeUndefined();
      expect(result.error).toMatch(/APP_BASE_URL must be an http\(s\) origin/);
    }
  });

  test('production requires https', () => {
    expect(parseAppBaseUrl('http://app.documind.test', 'production'))
      .toEqual({ value: undefined, error: 'APP_BASE_URL must use https in production' });
  });

  test.each([
    'https://localhost', 'https://LOCALHOST:8443', 'https://localhost.', 'https://app.localhost',
    'https://127.0.0.1', 'https://127.10.20.30', 'https://127.1', 'https://2130706433',
    'https://0.0.0.0', 'https://[::1]', 'https://[::]', 'https://[::ffff:127.0.0.1]',
  ])('production rejects localhost/loopback %p', (raw) => {
    expect(parseAppBaseUrl(raw, 'production')).toEqual({
      value: undefined,
      error: 'APP_BASE_URL must not be a localhost or loopback address in production',
    });
  });

  test('a normalized origin builds a fragment-only invite URL', () => {
    const original = env.APP_BASE_URL;
    try {
      env.APP_BASE_URL = parseAppBaseUrl('https://APP.documind.test/', 'production').value;
      expect(buildInviteUrl('abc_DEF-123')).toBe('https://app.documind.test/invite#token=abc_DEF-123');
      env.APP_BASE_URL = undefined;
      expect(buildInviteUrl('abc')).toBeNull();
    } finally {
      env.APP_BASE_URL = original;
    }
  });
});

describe('env.js wiring (child process)', () => {
  /** Load src/config/env.js with APP_BASE_URL set (or removed when undefined). */
  function loadEnv(appBaseUrl, overrides = {}) {
    const childEnv = { ...process.env, ...overrides };
    delete childEnv.APP_BASE_URL;
    if (appBaseUrl !== undefined) childEnv.APP_BASE_URL = appBaseUrl;
    const script = "const e = require('./src/config/env');"
      + "process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ value: e.APP_BASE_URL === undefined ? null : e.APP_BASE_URL }));";
    const child = spawnSync(process.execPath, ['-e', script], { cwd: BACKEND_DIR, env: childEnv, encoding: 'utf8', timeout: 20000 });
    const marker = child.stdout.indexOf('@@RESULT@@');
    return {
      status: child.status,
      output: `${child.stdout}\n${child.stderr}`,
      value: marker >= 0 ? JSON.parse(child.stdout.slice(marker + '@@RESULT@@'.length)).value : undefined,
    };
  }

  test('unset → undefined; empty string → undefined (same behaviour)', () => {
    expect(loadEnv(undefined, { NODE_ENV: 'test' })).toMatchObject({ status: 0, value: null });
    expect(loadEnv('', { NODE_ENV: 'test' })).toMatchObject({ status: 0, value: null });
  });

  test('a valid origin is exported normalized (trailing slash removed, host lowercased)', () => {
    expect(loadEnv('https://APP.documind.test/', { NODE_ENV: 'test' })).toMatchObject({ status: 0, value: 'https://app.documind.test' });
  });

  test.each([
    'https://app.documind.test/invite', 'https://app.documind.test?x=1', 'https://u:p@app.documind.test', 'nope',
  ])('an invalid value %p makes startup fail with an APP_BASE_URL error', (raw) => {
    const result = loadEnv(raw, { NODE_ENV: 'test' });
    expect(result.status).toBe(1);
    expect(result.output).toContain('APP_BASE_URL must be an http(s) origin');
  });

  test('production: http and loopback values are reported; a public https origin is not', () => {
    const http = loadEnv('http://app.documind.test', { NODE_ENV: 'production' });
    expect(http.status).toBe(1);
    expect(http.output).toContain('APP_BASE_URL must use https in production');

    const loopback = loadEnv('https://127.0.0.1', { NODE_ENV: 'production' });
    expect(loopback.status).toBe(1);
    expect(loopback.output).toContain('APP_BASE_URL must not be a localhost or loopback address in production');

    // Other production checks may still fail with the local test environment; APP_BASE_URL must not be among them.
    const valid = loadEnv('https://app.documind.test', { NODE_ENV: 'production' });
    expect(valid.output).not.toContain('APP_BASE_URL');
  });
});
