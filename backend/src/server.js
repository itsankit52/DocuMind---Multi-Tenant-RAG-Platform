require('dotenv').config();
const env = require('./config/env');
const logger = require('./observability/logger');
const { init: initMetrics } = require('./observability/metrics');

// Structured JSON logs for every log statement (including legacy console.* calls)
logger.configure({ service: 'documind-api', environment: env.NODE_ENV, level: env.LOG_LEVEL, format: env.LOG_FORMAT });
logger.captureConsole();
initMetrics({ service: 'documind-api' });

const app = require('./app');
const { pool } = require('./db');
const { getRedisClient } = require('./middleware/rate-limiter');
const { streamRegistry } = require('./sse/sse-session');

const minioService = require('./storage/minio.service');
const rabbitmqService = require('./queue/rabbitmq.service');

const PORT = env.PORT;

let server;

async function startServer() {
  try {
    await minioService.ensureBucketExists();
    console.log(`🪣 MinIO bucket "${env.MINIO_BUCKET}" ready.`);
  } catch (err) {
    console.error('⚠️ MinIO bucket initialization warning:', err.message);
  }

  server = app.listen(PORT, () => {
    console.log(`🚀 DocuMind Server running in ${env.NODE_ENV} mode on port ${PORT}`);
  });
}

startServer();

let shuttingDown = false;

async function closeResources() {
  try {
    await pool.end();
    console.log('PostgreSQL pool closed.');
    const redisClient = getRedisClient();
    if (redisClient && redisClient.isOpen) {
      await redisClient.quit();
      console.log('Redis client closed.');
    }
    if (rabbitmqService.connection) {
      await rabbitmqService.close();
      console.log('RabbitMQ connection closed.');
    }
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
}

async function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`
${signal} signal received. Closing HTTP server and resources...`);

  // Hard upper bound so a stuck connection cannot block container stop past its grace period.
  const forceExit = setTimeout(() => {
    console.error(`Graceful shutdown exceeded ${env.SHUTDOWN_TIMEOUT_MS}ms; forcing exit.`);
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Refuse new SSE streams and abort in-flight ones (Ollama requests are cancelled,
  // clients receive an SERVER_SHUTTING_DOWN error event) so server.close() can drain.
  const activeStreams = streamRegistry.activeCount();
  streamRegistry.beginShutdown();
  if (activeStreams > 0) {
    console.log(`Aborted ${activeStreams} active chat stream(s).`);
  }

  if (!server) {
    await closeResources();
    process.exit(0);
  }

  // Stop accepting new connections; in-flight requests finish, idle keep-alive sockets are closed.
  server.close(async () => {
    console.log('HTTP server closed.');
    await closeResources();
    process.exit(0);
  });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

// Graceful Shutdown
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
