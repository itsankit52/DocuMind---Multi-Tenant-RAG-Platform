require('dotenv').config();
const zod = require('zod');
const { parseAppBaseUrl } = require('./app-base-url');

const envSchema = zod.object({
  PORT: zod.string().transform(Number).prefault('3000'),
  NODE_ENV: zod.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: zod.string().url(),
  // Optional dedicated worker login (migration 013: documind_worker). Used only by the worker
  // process; when unset the worker keeps using DATABASE_URL (unchanged behaviour).
  WORKER_DATABASE_URL: zod.string().url().optional(),
  DATABASE_POOL_MAX: zod.string().transform(Number).prefault('20'),
  REDIS_URL: zod.string().url(),
  JWT_ACCESS_SECRET: zod.string().min(32),
  JWT_REFRESH_SECRET: zod.string().min(32),
  JWT_ACCESS_EXPIRATION: zod.string().default('15m'),
  JWT_REFRESH_EXPIRATION: zod.string().default('7d'),
  COOKIE_SECRET: zod.string().min(16).default('documind_default_cookie_signing_secret_32chars'),
  CORS_ORIGIN: zod.string().default('http://localhost:5173'),
  // Public frontend origin used to build invitation links (e.g. https://documind.example.com).
  // Optional: when unset or empty, invitation APIs return the token only and no URL. Never
  // derived from request headers (Host-header injection). Rules: ./app-base-url.js
  APP_BASE_URL: zod.string().optional(),
  PG_TENANT_SETTING: zod.string().default('app.current_tenant'),
  MINIO_ENDPOINT: zod.string().default('localhost'),
  MINIO_PORT: zod.string().transform(Number).prefault('9000'),
  MINIO_CONSOLE_PORT: zod.string().transform(Number).prefault('9001'),
  MINIO_ACCESS_KEY: zod.string().default('minioadmin'),
  MINIO_SECRET_KEY: zod.string().default('minioadminpassword'),
  MINIO_BUCKET: zod.string().default('documind-documents'),
  MINIO_USE_SSL: zod.string().transform(val => val === 'true').prefault('false'),
  MAX_FILE_SIZE_MB: zod.string().transform(Number).prefault('10'),
  RABBITMQ_URL: zod.string().default('amqp://guest:guest@localhost:5672'),
  RABBITMQ_HOST: zod.string().default('localhost'),
  RABBITMQ_PORT: zod.string().transform(Number).prefault('5672'),
  RABBITMQ_USER: zod.string().default('guest'),
  RABBITMQ_PASSWORD: zod.string().default('guest'),
  RABBITMQ_QUEUE: zod.string().default('documind.document.process'),
  RABBITMQ_RETRY_QUEUE: zod.string().default('documind.document.process.retry'),
  RABBITMQ_DLQ: zod.string().default('documind.document.process.dlq'),
  RABBITMQ_EXCHANGE: zod.string().default('documind.document.exchange'),
  CHUNK_SIZE: zod.string().transform(Number).prefault('1000'),
  CHUNK_OVERLAP: zod.string().transform(Number).prefault('150'),
  MAX_PROCESSING_ATTEMPTS: zod.string().transform(Number).prefault('3'),
  MAX_EXTRACTED_TEXT_MB: zod.string().transform(Number).prefault('20'),
  MAX_CHUNKS_PER_DOCUMENT: zod.string().transform(Number).prefault('5000'),
  // Qdrant Vector Store
  QDRANT_URL: zod.string().default('http://localhost:6333'),
  QDRANT_COLLECTION: zod.string().default('documind_chunks'),
  QDRANT_API_KEY: zod.string().optional().default(''),
  // Ollama Embeddings & LLM
  OLLAMA_BASE_URL: zod.string().default('http://localhost:11434'),
  OLLAMA_EMBEDDING_MODEL: zod.string().default('nomic-embed-text'),
  OLLAMA_LLM_MODEL: zod.string().default('llama3.2:1b'),
  EMBEDDING_DIMENSION: zod.string().transform(Number).prefault('768'),
  // RAG Retrieval & Prompt Limits
  RAG_TOP_K: zod.string().transform(Number).prefault('5'),
  RAG_SCORE_THRESHOLD: zod.string().transform(Number).prefault('0.0'),
  RAG_MAX_CONTEXT_CHARS: zod.string().transform(Number).prefault('15000'),
  RAG_MAX_QUESTION_LENGTH: zod.string().transform(Number).prefault('1000'),
  // Conversation / Chat Configuration
  MAX_CONVERSATION_MESSAGES: zod.string().transform(Number).prefault('10'),
  MAX_CONVERSATION_CONTEXT_CHARS: zod.string().transform(Number).prefault('4000'),
  CHAT_MAX_QUESTION_LENGTH: zod.string().transform(Number).prefault('1000'),
  CHAT_RATE_LIMIT: zod.string().transform(Number).prefault('20'),
  CHAT_RATE_WINDOW: zod.string().transform(Number).prefault('60000'),
  // SSE Streaming Configuration
  SSE_HEARTBEAT_INTERVAL_MS: zod.string().transform(Number).prefault('15000'),
  CHAT_STREAM_TIMEOUT_MS: zod.string().transform(Number).prefault('120000'),
  MAX_STREAMED_RESPONSE_CHARS: zod.string().transform(Number).prefault('10000'),

  // Observability (Step 13)
  METRICS_ENABLED: zod.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // Optional bearer token for GET /metrics. When empty, /metrics is only served to loopback/private-network clients.
  METRICS_TOKEN: zod.string().default(''),
  LOG_LEVEL: zod.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  LOG_FORMAT: zod.enum(['json', 'pretty']).default('json'),
  WORKER_METRICS_PORT: zod.string().transform(Number).prefault('9464'),
  HEALTH_CHECK_TIMEOUT_MS: zod.string().transform(Number).prefault('2000'),
  OLLAMA_TIMEOUT_MS: zod.string().transform(Number).prefault('120000'),
  QDRANT_TIMEOUT_MS: zod.string().transform(Number).prefault('30000'),
  JOB_LOCK_TIMEOUT_MINUTES: zod.string().transform(Number).prefault('30'),
  OUTBOX_RELAY_INTERVAL_MS: zod.string().transform(Number).prefault('15000'),
  // Stale-job recovery: how often the worker sweeps for abandoned jobs, and how many per sweep
  JOB_RECOVERY_INTERVAL_MS: zod.string().transform(Number).prefault('60000'),
  JOB_RECOVERY_BATCH_SIZE: zod.string().transform(Number).prefault('50'),
  // Deliveries whose job lookup keeps failing (database errors) are dead-lettered after this many
  JOB_LOOKUP_MAX_ATTEMPTS: zod.string().transform(Number).prefault('5'),

  // Production deployment (Step 14)
  // Express "trust proxy": number of reverse-proxy hops in front of the API (1 = Nginx only).
  // Leave empty when the API is reached directly (development). Required for correct req.ip
  // (rate limiting) behind Nginx; X-Forwarded-For from clients is never trusted beyond this.
  TRUST_PROXY: zod.string().regex(/^\d*$/, 'TRUST_PROXY must be a hop count').default('')
    .transform(v => (v === '' ? false : Number(v))),
  // Upper bound for graceful shutdown before the process force-exits (keep below Docker stop_grace_period)
  SHUTDOWN_TIMEOUT_MS: zod.string().transform(Number).prefault('20000'),
}).refine(data => data.CHUNK_OVERLAP < data.CHUNK_SIZE, {
  message: 'CHUNK_OVERLAP must be strictly less than CHUNK_SIZE',
  path: ['CHUNK_OVERLAP'],
});

// Secrets that must never reach production with their built-in development defaults.
const DEV_DEFAULTS = {
  COOKIE_SECRET: 'documind_default_cookie_signing_secret_32chars',
  MINIO_ACCESS_KEY: 'minioadmin',
  MINIO_SECRET_KEY: 'minioadminpassword',
};

const productionSchema = envSchema.superRefine((data, ctx) => {
  const appBaseUrl = parseAppBaseUrl(data.APP_BASE_URL, data.NODE_ENV);
  if (appBaseUrl.error) {
    ctx.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: appBaseUrl.error });
  }
  if (data.NODE_ENV !== 'production') return;
  const origins = data.CORS_ORIGIN.split(',').map(o => o.trim());
  if (origins.some(o => o === '*' || o === '')) {
    ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'Wildcard/empty CORS origin is not allowed in production (credentialed requests)' });
  }
  for (const [key, devValue] of Object.entries(DEV_DEFAULTS)) {
    if (data[key] === devValue) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} must be set explicitly in production` });
    }
  }
  if (/\/\/guest:guest@/.test(data.RABBITMQ_URL)) {
    ctx.addIssue({ code: 'custom', path: ['RABBITMQ_URL'], message: 'Default RabbitMQ guest credentials are not allowed in production' });
  }
});

const parsed = productionSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

// Normalized origin (or undefined when unset/empty); validated above.
parsed.data.APP_BASE_URL = parseAppBaseUrl(parsed.data.APP_BASE_URL, parsed.data.NODE_ENV).value;

module.exports = parsed.data;

