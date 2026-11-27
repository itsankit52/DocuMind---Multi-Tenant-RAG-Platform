/**
 * Redis query-embedding cache (src/rag/query-embedding-cache.js) through retrievalService.
 *  - a repeated question in the same organization skips the embedding call
 *  - keys are organization-scoped and never contain the question text
 *  - another organization (or another model) never reuses the entry
 *  - retrieval itself always runs live (Qdrant search with the organization filter)
 *  - Redis failures fall back to computing the embedding; TTL 0 disables the cache
 * Redis test database only; Qdrant and Ollama are stubbed.
 */

const env = require('../../src/config/env');
const embeddingService = require('../../src/embeddings/embedding.service');
const qdrantService = require('../../src/vector/qdrant.service');
const retrievalService = require('../../src/rag/retrieval.service');
const cache = require('../../src/rag/query-embedding-cache');
const { getRedisClient } = require('../../src/middleware/rate-limiter');

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 10);
const QUESTION = 'What is the vacation policy?';
const VECTOR_F32 = VECTOR.map(v => Math.fround(v)); // what retrieval receives with the cache on

let redis;
let embedSpy;
let searchSpy;
const originalTtl = env.RAG_EMBEDDING_CACHE_TTL_SECONDS;

async function clearCache() {
  const keys = await redis.keys(`${cache.PREFIX}:*`);
  if (keys.length) await redis.del(keys);
}
const flush = () => new Promise(r => setTimeout(r, 50)); // the cache write is not awaited by callers

beforeAll(async () => {
  redis = getRedisClient();
  if (!redis.isOpen) await redis.connect();
});
beforeEach(async () => {
  env.RAG_EMBEDDING_CACHE_TTL_SECONDS = 3600;
  await clearCache();
  embedSpy = jest.spyOn(embeddingService, 'embedText').mockResolvedValue(VECTOR);
  searchSpy = jest.spyOn(qdrantService, 'searchPoints').mockResolvedValue([]); // no matches → no DB work
});
afterEach(() => {
  jest.restoreAllMocks();
  env.RAG_EMBEDDING_CACHE_TTL_SECONDS = originalTtl;
});
afterAll(async () => {
  await clearCache();
  await redis.quit();
});

const ask = (organizationId, question = QUESTION) => retrievalService.retrieveContext({ organizationId, question });

test('a repeated question in the same organization is embedded once; search still runs every time', async () => {
  await ask(ORG_A);
  await flush();
  await ask(ORG_A);
  expect(embedSpy).toHaveBeenCalledTimes(1);
  expect(searchSpy).toHaveBeenCalledTimes(2);
  for (const [, params] of searchSpy.mock.calls) {
    expect(params.organizationId).toBe(ORG_A);
    expect(params.vector).toEqual(VECTOR_F32); // identical on the miss and the hit
  }
});

test('the key is organization-scoped, has a TTL and never contains the question text', async () => {
  await ask(ORG_A);
  await flush();
  const keys = await redis.keys(`${cache.PREFIX}:*`);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(new RegExp(`^${cache.PREFIX}:${ORG_A}:[0-9a-f]{64}$`));
  expect(keys[0]).not.toContain('vacation');
  const ttl = await redis.ttl(keys[0]);
  expect(ttl).toBeGreaterThan(3500);
  expect(ttl).toBeLessThanOrEqual(3600);
});

test('another organization asking the same question does not reuse the entry', async () => {
  await ask(ORG_A);
  await flush();
  await ask(ORG_B);
  expect(embedSpy).toHaveBeenCalledTimes(2);
  expect(await redis.keys(`${cache.PREFIX}:${ORG_B}:*`)).toHaveLength(1);
});

test('a different embedding model gets a different key', () => {
  expect(cache.cacheKey(ORG_A, 'nomic-embed-text', QUESTION)).not.toBe(cache.cacheKey(ORG_A, 'other-model', QUESTION));
  expect(cache.cacheKey(ORG_A, 'm', QUESTION)).toBe(cache.cacheKey(ORG_A.toUpperCase(), 'm', QUESTION));
});

test('values are packed float32: exact for float32 vectors and much smaller than JSON', async () => {
  const f32 = Array.from(new Float32Array([0.1, -0.25, 3.5e-7, 12.75]));
  expect(cache.decode(cache.encode(f32))).toEqual(f32);
  await ask(ORG_A);
  await flush();
  const [key] = await redis.keys(`${cache.PREFIX}:*`);
  const stored = await redis.get(key);
  expect(cache.decode(stored)).toEqual(VECTOR_F32);
  // Realistic model output (values like -0.0123456789): JSON is ~4x the packed size
  const realistic = Array.from({ length: 768 }, (_, i) => Math.fround(Math.sin(i + 1) * 0.05));
  expect(cache.encode(realistic).length * 3).toBeLessThan(JSON.stringify(realistic).length);
});

test('a corrupt cache entry is ignored and recomputed', async () => {
  await redis.set(cache.cacheKey(ORG_A, embeddingService.model, QUESTION), 'abc', { EX: 60 });
  await ask(ORG_A);
  expect(embedSpy).toHaveBeenCalledTimes(1);
});

test('Redis read failure falls back to computing the embedding', async () => {
  jest.spyOn(redis, 'get').mockRejectedValue(new Error('connection lost'));
  await ask(ORG_A);
  expect(embedSpy).toHaveBeenCalledTimes(1);
  expect(searchSpy).toHaveBeenCalledTimes(1);
});

test('TTL 0 disables the cache entirely', async () => {
  env.RAG_EMBEDDING_CACHE_TTL_SECONDS = 0;
  await ask(ORG_A);
  await flush();
  await ask(ORG_A);
  expect(embedSpy).toHaveBeenCalledTimes(2);
  expect(await redis.keys(`${cache.PREFIX}:*`)).toHaveLength(0);
});

test('embedding errors are not cached and still surface as 503', async () => {
  embedSpy.mockRejectedValueOnce(new Error('ollama down'));
  await expect(ask(ORG_A)).rejects.toMatchObject({ statusCode: 503 });
  await flush();
  expect(await redis.keys(`${cache.PREFIX}:*`)).toHaveLength(0);
});
