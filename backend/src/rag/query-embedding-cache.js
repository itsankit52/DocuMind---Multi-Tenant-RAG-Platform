/**
 * Redis cache for question embeddings (RAG stage 1).
 *
 * Repeated questions skip the Ollama embedding call. Only the question's vector is cached —
 * never chunks, documents or answers — so retrieval still runs live against Qdrant (organization
 * filter) and PostgreSQL (RLS): new, reprocessed or deleted documents are reflected immediately.
 *
 * Keys are tenant-scoped and never contain the question text:
 *   rag:qemb:v1:<organizationId>:<sha256(model + "\n" + question)>
 * Values are packed float32 (base64): the model's own precision, ~4x smaller
 * than JSON, which matters because production Redis is memory-capped (volatile-ttl eviction).
 * Fail-open: any Redis error or timeout falls back to computing the embedding.
 * RAG_EMBEDDING_CACHE_TTL_SECONDS=0 disables the cache.
 */

const crypto = require('crypto');
const env = require('../config/env');
const { getRedisClient } = require('../middleware/rate-limiter');
const { metrics, safe } = require('../observability/metrics');
const logger = require('../observability/logger');

const PREFIX = 'rag:qemb:v1';
const OP_TIMEOUT_MS = 250;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cacheKey(organizationId, model, question) {
  const digest = crypto.createHash('sha256').update(`${model}\n${question}`, 'utf8').digest('hex');
  return `${PREFIX}:${String(organizationId).toLowerCase()}:${digest}`;
}

function ttlSeconds() {
  const ttl = Number(env.RAG_EMBEDDING_CACHE_TTL_SECONDS);
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 0;
}

/** A usable connected client, or null (cache skipped). */
function readyClient() {
  const client = getRedisClient();
  return client && client.isReady ? client : null;
}

const isVector = (v) => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite);

function encode(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

/** The cached vector, or null when the value is not a well-formed packed float32 array. */
function decode(raw) {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 0 || buf.length % 4 !== 0) return null;
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const vector = Array.from(floats);
  return isVector(vector) ? vector : null;
}

function record(result) {
  safe(() => metrics.ragEmbeddingCache.inc({ result }));
}

/**
 * Return the cached embedding for (organization, model, question), or compute it with
 * `compute()` and store it. `compute` errors propagate unchanged; cache errors never do.
 */
async function getOrCompute({ organizationId, model, question }, compute) {
  const ttl = ttlSeconds();
  const client = ttl ? readyClient() : null;
  if (!client) return compute();

  const key = cacheKey(organizationId, model, question);
  try {
    const raw = await withTimeout(client.get(key), OP_TIMEOUT_MS);
    if (raw) {
      const vector = decode(raw);
      if (vector) {
        record('hit');
        return vector;
      }
    }
  } catch (err) {
    record('error');
    logger.warn('Query embedding cache read failed', { operation: 'get', error: { type: err.name, message: 'redis read failed' } });
  }

  record('miss');
  const vector = await compute();
  if (!isVector(vector)) return vector;
  // Return exactly what a later hit returns, so results never depend on the cache state
  const packed = encode(vector);
  withTimeout(client.set(key, packed, { EX: ttl }), OP_TIMEOUT_MS).catch(() => {
    record('error');
  });
  return decode(packed);
}

module.exports = { getOrCompute, cacheKey, encode, decode, PREFIX };
