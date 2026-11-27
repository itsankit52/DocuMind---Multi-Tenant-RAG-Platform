/**
 * One-time OAuth state for the Google flow, stored in Redis.
 *
 * At initiation: a random `state` (sent to Google) and a random browser-binding value (set as
 * an HttpOnly cookie) are created. Redis keeps, under sha256(state), for STATE_TTL_SECONDS:
 *   { bindingHash, codeVerifier (PKCE), nonce, intent: 'login' | 'link', userId? }
 * At the callback the record is fetched AND deleted atomically (GETDEL), so a state can be used
 * once; it must also match the binding cookie of the same browser (login-CSRF protection: an
 * attacker cannot complete their own Google login in a victim's browser). Raw state and binding
 * values are never stored or logged — only their hashes are keys/fields.
 * Redis unavailable → fail closed (the flow cannot start or complete).
 */

const crypto = require('crypto');
const { getRedisClient } = require('../middleware/rate-limiter');

const STATE_TTL_SECONDS = 600;
const PREFIX = 'oauth:google:state:';
const OP_TIMEOUT_MS = 1000;

const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), OP_TIMEOUT_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function readyClient() {
  const client = getRedisClient();
  if (!client.isOpen) await withTimeout(client.connect());
  return client;
}

/** Persist a new state record. Throws when Redis is unavailable (caller fails closed). */
async function saveState({ state, binding, codeVerifier, nonce, intent, userId = null }) {
  const client = await readyClient();
  const record = JSON.stringify({ bindingHash: sha256(binding), codeVerifier, nonce, intent, userId });
  await withTimeout(client.set(PREFIX + sha256(state), record, { EX: STATE_TTL_SECONDS, NX: true }));
}

/**
 * Fetch and delete the record for `state` (one-time). Returns null when unknown/expired/used.
 * The binding check is done by the caller with matchesBinding().
 */
async function consumeState(state) {
  const client = await readyClient();
  const raw = await withTimeout(client.getDel(PREFIX + sha256(state)));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function matchesBinding(record, binding) {
  if (!record || typeof binding !== 'string' || binding.length === 0) return false;
  const a = Buffer.from(record.bindingHash || '', 'hex');
  const b = Buffer.from(sha256(binding), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { saveState, consumeState, matchesBinding, STATE_TTL_SECONDS, PREFIX, sha256 };
