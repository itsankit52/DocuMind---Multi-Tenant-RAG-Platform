/**
 * ID-token verification with the REAL google-auth-library verification code. Only Google's
 * signing-key download is replaced: the tests sign tokens with a locally generated RSA key and
 * serve its public key as Google's certificate. No network, no database.
 * Also: configuration rules (google-oauth-config.js).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const env = require('../../src/config/env');
const google = require('../../src/auth/google.oauth');
const { checkGoogleOAuthConfig } = require('../../src/config/google-oauth-config');

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const KID = 'test-key-1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const saved = {};
beforeAll(() => {
  saved.id = env.GOOGLE_CLIENT_ID;
  env.GOOGLE_CLIENT_ID = CLIENT_ID;
  const client = new OAuth2Client({ clientId: CLIENT_ID });
  client.getFederatedSignonCertsAsync = async () => ({ certs: { [KID]: PEM }, format: 'PEM' });
  google.setClientForTests(client);
});
afterAll(() => { env.GOOGLE_CLIENT_ID = saved.id; google.setClientForTests(null); });

const now = () => Math.floor(Date.now() / 1000);
function sign(claims = {}, { key = privateKey, kid = KID } = {}) {
  return jwt.sign({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234567890', email: 'Person@Example.com',
    email_verified: true, nonce: 'n-1', name: 'Person', picture: 'https://lh3.googleusercontent.com/a',
    iat: now(), exp: now() + 3600, ...claims,
  }, key, { algorithm: 'RS256', keyid: kid });
}
const verify = (token, nonce = 'n-1') => google.verifyIdToken(token, { nonce });
const code = (p) => p.then(() => 'ok', e => e.code);

test('a valid token yields the normalized identity', async () => {
  await expect(verify(sign())).resolves.toEqual({
    sub: '1234567890', email: 'person@example.com', emailVerified: true, name: 'Person', picture: 'https://lh3.googleusercontent.com/a',
  });
  await expect(verify(sign({ iss: 'accounts.google.com' }))).resolves.toMatchObject({ sub: '1234567890' });
});

test.each([
  ['wrong signing key', () => sign({}, { key: other.privateKey })],
  ['unknown key id', () => sign({}, { kid: 'nope' })],
  ['invalid issuer', () => sign({ iss: 'https://evil.example' })],
  ['invalid audience', () => sign({ aud: 'someone-else.apps.googleusercontent.com' })],
  ['expired', () => sign({ iat: now() - 7200, exp: now() - 3600 })],
  ['not a JWT', () => 'not-a-token'],
])('rejects a token with %s', async (_label, make) => {
  expect(await code(verify(make()))).toBe('id_token_invalid');
});

test('rejects a nonce mismatch or missing subject', async () => {
  expect(await code(verify(sign(), 'another-nonce'))).toBe('id_token_invalid');
  expect(await code(verify(sign({ sub: '' })))).toBe('id_token_invalid');
});

test('requires a verified email', async () => {
  expect(await code(verify(sign({ email_verified: false })))).toBe('email_unverified');
  expect(await code(verify(sign({ email_verified: 'true' })))).toBe('email_unverified');
  expect(await code(verify(sign({ email: undefined })))).toBe('email_missing');
});

test('only https avatar URLs are kept', async () => {
  expect((await verify(sign({ picture: 'http://insecure.example/a.png' }))).picture).toBeNull();
  expect((await verify(sign({ picture: 'javascript:alert(1)' }))).picture).toBeNull();
});

test('PKCE pair: 43-char verifier, S256 challenge', () => {
  const { verifier, challenge } = google.createPkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
});

describe('configuration rules', () => {
  const full = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback', APP_BASE_URL: 'http://localhost:5173', NODE_ENV: 'development' };
  const paths = (data) => checkGoogleOAuthConfig(data).issues.map(i => i.path);

  test('all unset or empty → disabled without error', () => {
    expect(checkGoogleOAuthConfig({ NODE_ENV: 'development' })).toEqual({ enabled: false, issues: [] });
    expect(checkGoogleOAuthConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: ' ', GOOGLE_CALLBACK_URL: '' })).toEqual({ enabled: false, issues: [] });
  });
  test('complete → enabled', () => expect(checkGoogleOAuthConfig(full)).toEqual({ enabled: true, issues: [] }));
  test('partial configuration is an error naming the missing keys', () => {
    expect(paths({ ...full, GOOGLE_CLIENT_SECRET: '' })).toEqual(['GOOGLE_CLIENT_SECRET']);
  });
  test('callback URL must be the exact callback path, without query/credentials', () => {
    for (const bad of ['http://localhost:3000/callback', 'http://localhost:3000/api/auth/google/callback?x=1', 'http://u:p@localhost:3000/api/auth/google/callback', 'ftp://x/api/auth/google/callback', 'not a url']) {
      expect(paths({ ...full, GOOGLE_CALLBACK_URL: bad })).toEqual(['GOOGLE_CALLBACK_URL']);
    }
  });
  test('production requires https and a public host', () => {
    expect(paths({ ...full, NODE_ENV: 'production' })).toEqual(['GOOGLE_CALLBACK_URL']);
    expect(checkGoogleOAuthConfig({ ...full, NODE_ENV: 'production', GOOGLE_CALLBACK_URL: 'https://documind.example.com/api/auth/google/callback' }).enabled).toBe(true);
  });
  test('requires APP_BASE_URL; messages never contain the secret', () => {
    const { issues } = checkGoogleOAuthConfig({ ...full, APP_BASE_URL: undefined });
    expect(issues.map(i => i.path)).toEqual(['APP_BASE_URL']);
    expect(JSON.stringify(checkGoogleOAuthConfig({ ...full, GOOGLE_CALLBACK_URL: 'bad' }))).not.toContain('secret');
  });
});
