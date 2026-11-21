const { pool } = require('../db');
const minioService = require('../storage/minio.service');
const rabbitmqService = require('../queue/rabbitmq.service');
const DocumentProcessor = require('./processor');
const env = require('../config/env');

class DocumentWorker {
  constructor(options = {}) {
    this.workerId = options.workerId || `documind-worker-${process.pid}-${Date.now()}`;
    this.processor = new DocumentProcessor(this.workerId);
    this.isRunning = false;
    this.consumerTag = null;
    this.activeJobs = 0; // in-flight deliveries (prefetch 1), drained on graceful stop
  }

  async start() {
    if (this.isRunning) return;

    console.log(`🚀 Starting DocuMind Document Processing Worker [${this.workerId}]...`);

    // 1. Verify PostgreSQL connection
    try {
      const dbRes = await pool.query('SELECT current_database(), now()');
      console.log(`📦 PostgreSQL connected: ${dbRes.rows[0].current_database}`);
    } catch (err) {
      console.error('❌ PostgreSQL connection failed on worker start:', err.message);
      throw err;
    }

    // 2. Verify MinIO connection & bucket
    try {
      await minioService.ensureBucketExists();
      console.log(`🪣 MinIO bucket "${env.MINIO_BUCKET}" ready.`);
    } catch (err) {
      console.error('❌ MinIO connection failed on worker start:', err.message);
      throw err;
    }

    // 3. Connect to RabbitMQ and start consuming
    try {
      await rabbitmqService.connect();
      console.log('🐇 RabbitMQ connected'); // never log the URL: it embeds credentials

      const consumeRes = await rabbitmqService.consume(
        async (msg, parsedData, ack, nack, retry) => {
          this.activeJobs += 1;
          try {
            const headers = (msg.properties && msg.properties.headers) || {};
            await this.processor.processJob(parsedData, { ack, nack, retry, headers });
          } finally {
            this.activeJobs -= 1;
          }
        },
        { prefetch: 1 }
      );

      this.consumerTag = consumeRes.consumerTag;
      this.isRunning = true;
      console.log(`👂 Worker [${this.workerId}] listening for jobs on queue "${env.RABBITMQ_QUEUE}"`);
    } catch (err) {
      console.error('❌ RabbitMQ consumer initialization failed:', err.message);
      throw err;
    }
  }

  /**
   * Graceful stop: cancel the consumer (no new deliveries), let the in-flight job finish
   * within drainTimeoutMs, then close the connection. A job still running at the deadline
   * stays unacked, so RabbitMQ redelivers it to another worker (processing is idempotent).
   */
  async stop({ drainTimeoutMs = 20000 } = {}) {
    if (!this.isRunning) {
      await rabbitmqService.close();
      return;
    }
    console.log(`🛑 Stopping Worker [${this.workerId}] gracefully...`);
    this.isRunning = false;

    try {
      if (this.consumerTag && rabbitmqService.channel) {
        await rabbitmqService.channel.cancel(this.consumerTag);
        console.log('🐇 Consumer cancelled; no new jobs will be received.');
      }
    } catch (err) {
      console.error('Error cancelling RabbitMQ consumer:', err.message);
    }

    const deadline = Date.now() + drainTimeoutMs;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.activeJobs > 0) {
      console.warn(`⚠️ ${this.activeJobs} job(s) still running at shutdown; leaving unacked for redelivery.`);
    }

    try {
      await rabbitmqService.close();
      console.log('🐇 RabbitMQ channel and connection closed.');
    } catch (err) {
      console.error('Error closing RabbitMQ:', err.message);
    }
    this.consumerTag = null;
  }
}

module.exports = DocumentWorker;
