// Must precede every module that loads src/db: selects WORKER_DATABASE_URL for this process.
process.env.DOCUMIND_PROCESS_ROLE = 'worker';
require('dotenv').config();
const env = require('./config/env');
const logger = require('./observability/logger');
const { init: initMetrics } = require('./observability/metrics');

logger.configure({ service: 'documind-worker', environment: env.NODE_ENV, level: env.LOG_LEVEL, format: env.LOG_FORMAT });
logger.captureConsole();
initMetrics({ service: 'documind-worker' });

const DocumentWorker = require('./workers/document.worker');
const rabbitmqService = require('./queue/rabbitmq.service');
const { pool } = require('./db');
const { createWorkerServer } = require('./observability/worker-server');
const { startOutboxRelay } = require('./queue/outbox.relay');
const { startJobRecovery } = require('./workers/job-recovery');

const worker = new DocumentWorker();

const observabilityServer = createWorkerServer({
  isConsuming: () => Boolean(worker.isRunning && rabbitmqService.channel),
  checkDb: () => pool.query('SELECT 1'),
});

let shuttingDown = false;
let restartTimer = null;
let stopOutboxRelay = null;
let stopJobRecovery = null;

// Dependencies may still be starting (or restarting) — retry with capped exponential backoff
// instead of exiting, and re-subscribe if the RabbitMQ connection drops after startup.
async function startWithRetry(attempt = 1) {
  if (shuttingDown) return;
  try {
    await worker.start();
    const { connection } = rabbitmqService;
    if (connection) {
      connection.once('close', () => {
        if (shuttingDown) return;
        logger.warn('RabbitMQ connection lost; worker will reconnect');
        worker.isRunning = false;
        worker.consumerTag = null;
        scheduleRestart(1);
      });
    }
  } catch (err) {
    worker.isRunning = false;
    await rabbitmqService.close().catch(() => {});
    scheduleRestart(attempt + 1, err);
  }
}

function scheduleRestart(attempt, err) {
  if (shuttingDown) return;
  const delayMs = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30000);
  logger.warn('Worker dependencies unavailable; retrying', { attempt, delayMs, ...(err ? { error: err } : {}) });
  restartTimer = setTimeout(() => startWithRetry(attempt), delayMs);
}

async function run() {
  observabilityServer.listen(env.WORKER_METRICS_PORT, () => {
    logger.info('Worker metrics server listening', { port: env.WORKER_METRICS_PORT });
  });
  observabilityServer.on('error', (err) => {
    // Observability must not stop the worker (e.g. port already in use)
    logger.warn('Worker metrics server unavailable', { error: err });
  });

  await startWithRetry();

  // Republish upload/reprocess events whose direct publish never reached RabbitMQ
  stopOutboxRelay = startOutboxRelay({ intervalMs: env.OUTBOX_RELAY_INTERVAL_MS });

  // Requeue (via the outbox) or fail jobs abandoned by a crashed/killed worker
  stopJobRecovery = startJobRecovery({ intervalMs: env.JOB_RECOVERY_INTERVAL_MS });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (stopOutboxRelay) stopOutboxRelay();
  if (stopJobRecovery) stopJobRecovery();
  logger.info('Worker shutdown requested', { signal });

  const forceExit = setTimeout(() => {
    logger.error('Worker shutdown timed out; forcing exit', { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS + 5000);
  forceExit.unref();

  try {
    await worker.stop({ drainTimeoutMs: env.SHUTDOWN_TIMEOUT_MS });
    await pool.end();
    observabilityServer.close();
    logger.info('Worker stopped cleanly');
    process.exit(0);
  } catch (err) {
    logger.error('Error during worker shutdown', { error: err });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

run();
