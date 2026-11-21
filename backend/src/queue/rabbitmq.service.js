const amqp = require('amqplib');
const env = require('../config/env');
const { metrics, safe } = require('../observability/metrics');

// Must equal the x-message-ttl the retry queue is declared with. RabbitMQ applies the lower of
// the queue TTL and a message's expiration, and redeclaring a durable queue with different
// arguments fails with PRECONDITION_FAILED. Longer delays are therefore made of several hops
// through the retry queue, each at most this long (see NOT_BEFORE_HEADER).
const RETRY_QUEUE_TTL_MS = 5000;
// Absolute time (epoch ms) before which a retried message must not be processed.
const NOT_BEFORE_HEADER = 'x-documind-not-before';
// Only our own headers are carried across hops (never x-death & co., which grow per hop).
const OWN_HEADER_PREFIX = 'x-documind-';

// Channels that have closed. A delivery can only be settled on the channel that delivered it.
const closedChannels = new WeakSet();
const trackedChannels = new WeakSet();

function isChannelOpen(channel) {
  return Boolean(channel) && !closedChannels.has(channel);
}

function ownHeaders(msg) {
  const headers = (msg && msg.properties && msg.properties.headers) || {};
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith(OWN_HEADER_PREFIX)));
}

class RabbitMQService {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.isConnecting = false;
    this.monitorChannel = null; // separate channel for queue-depth checks (never the consumer channel)
  }

  /**
   * Connects to RabbitMQ and ensures queue topology.
   */
  async connect() {
    if (this.connection && this.channel) {
      return { connection: this.connection, channel: this.channel };
    }

    if (this.isConnecting) {
      // Wait for ongoing connection
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.connection && this.channel) {
        return { connection: this.connection, channel: this.channel };
      }
    }

    this.isConnecting = true;
    try {
      const connection = await amqp.connect(env.RABBITMQ_URL);
      this.connection = connection;
      // Confirm channel: publish() resolves only once the broker has taken responsibility for
      // the message, so callers (outbox markPublished, retry-then-ack) never lose it silently.
      const channel = await connection.createConfirmChannel();
      this.channel = channel;
      this._trackChannel(channel);

      // A channel-level error (e.g. double ack) must not become an unhandled 'error' event
      // that crashes the process.
      channel.on('error', (err) => {
        console.error('RabbitMQ channel error:', err.message);
      });
      // Every handler below checks identity: events from a replaced connection/channel must
      // never clear or close its replacement.
      channel.on('close', () => {
        if (this.channel === channel) this.channel = null;
        // Unexpected channel loss: drop the connection too so the next connect() (and the
        // worker's reconnect loop) starts from a clean connection + channel pair.
        if (!this.closing && this.connection === connection) connection.close().catch(() => {});
      });

      connection.on('error', (err) => {
        console.error('RabbitMQ connection error:', err.message);
        if (this.connection === connection) {
          this.connection = null;
          this.channel = null;
        }
      });

      connection.on('close', () => {
        closedChannels.add(channel);
        if (this.connection === connection) {
          this.connection = null;
          this.channel = null;
          this.monitorChannel = null;
        }
      });

      await this.setupTopology();
      return { connection: this.connection, channel: this.channel };
    } finally {
      this.isConnecting = false;
    }
  }

  /** Remember when a channel closes (idempotent per channel). */
  _trackChannel(channel) {
    if (!channel || trackedChannels.has(channel) || typeof channel.once !== 'function') return;
    trackedChannels.add(channel);
    channel.once('close', () => closedChannels.add(channel));
  }

  /**
   * Idempotently declares exchanges, queues, DLQ, and retry queues.
   */
  async setupTopology() {
    if (!this.channel) return;

    // 1. Declare Dead-Letter Queue (DLQ)
    await this.channel.assertQueue(env.RABBITMQ_DLQ, {
      durable: true,
    });

    // 2. Declare Retry Queue with message TTL (5 seconds exponential base) and dead-letter back to main queue
    await this.channel.assertQueue(env.RABBITMQ_RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': env.RABBITMQ_QUEUE,
        'x-message-ttl': RETRY_QUEUE_TTL_MS, // never change: see RETRY_QUEUE_TTL_MS
      },
    });

    // 3. Declare Main Processing Queue with dead-lettering to DLQ
    await this.channel.assertQueue(env.RABBITMQ_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': env.RABBITMQ_DLQ,
      },
    });
  }

  /**
   * Publishes a message to the main processing queue.
   * @param {object} payload
   * @param {object} [options]
   */
  async publish(payload, options = {}) {
    await this.connect();
    const content = Buffer.from(JSON.stringify(payload));
    const sent = this.channel.sendToQueue(env.RABBITMQ_QUEUE, content, {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      ...options,
    });
    await this.channel.waitForConfirms();
    safe(() => metrics.queuePublished.inc({ queue: 'main', status: sent ? 'success' : 'buffered' }));
    return sent;
  }

  /**
   * Publishes a message to the retry queue for delayed reprocessing.
   * The full delay is recorded as an absolute NOT_BEFORE_HEADER; each pass through the retry
   * queue lasts at most RETRY_QUEUE_TTL_MS and consume() sends early arrivals round again,
   * so delays longer than the queue TTL are honoured instead of being cut to 5 s.
   * @param {object} payload
   * @param {number} [delayMs=5000]
   * @param {object} [headers] - x-documind-* headers; an existing NOT_BEFORE_HEADER is kept
   */
  async publishRetry(payload, delayMs = RETRY_QUEUE_TTL_MS, headers = {}) {
    await this.connect();
    const now = Date.now();
    const notBefore = Number(headers[NOT_BEFORE_HEADER]) || now + Math.max(0, Number(delayMs) || 0);
    const hopMs = Math.min(Math.max(notBefore - now, 1), RETRY_QUEUE_TTL_MS);
    const content = Buffer.from(JSON.stringify(payload));
    const sent = this.channel.sendToQueue(env.RABBITMQ_RETRY_QUEUE, content, {
      persistent: true,
      contentType: 'application/json',
      expiration: String(Math.ceil(hopMs)),
      timestamp: now,
      headers: { ...headers, [NOT_BEFORE_HEADER]: notBefore },
    });
    await this.channel.waitForConfirms();
    safe(() => metrics.queuePublished.inc({ queue: 'retry', status: sent ? 'success' : 'buffered' }));
    return sent;
  }

  /**
   * Publishes a message directly to the Dead Letter Queue.
   * @param {object} payload
   * @param {string} reason
   */
  async publishDeadLetter(payload, reason = 'Max attempts exceeded') {
    await this.connect();
    const content = Buffer.from(JSON.stringify({ ...payload, dlqReason: reason, dlqAt: new Date().toISOString() }));
    const sent = this.channel.sendToQueue(env.RABBITMQ_DLQ, content, {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
    });
    await this.channel.waitForConfirms();
    safe(() => metrics.queuePublished.inc({ queue: 'dlq', status: sent ? 'success' : 'buffered' }));
    return sent;
  }

  /**
   * Sets up consumer on the main document processing queue.
   * @param {function} handler - async function(msg, parsedData, ack, nack, retry)
   * @param {object} [config]
   */
  async consume(handler, { prefetch = 1 } = {}) {
    await this.connect();
    // Delivery tags are scoped to the channel that delivered the message. Settle every message
    // on that channel only: after a reconnect `this.channel` is a different channel, where an
    // old tag would ack an unrelated message or trigger 406 PRECONDITION_FAILED.
    const deliveryChannel = this.channel;
    this._trackChannel(deliveryChannel);
    await deliveryChannel.prefetch(prefetch);

    return await deliveryChannel.consume(
      env.RABBITMQ_QUEUE,
      async (msg) => {
        if (!msg) return;
        safe(() => metrics.queueConsumed.inc());

        /** Run a settle operation on the delivery channel; false if it could not be done. */
        const settle = (operation, fn) => {
          if (!isChannelOpen(deliveryChannel)) {
            // The broker returned this unacked delivery to the queue when the channel closed;
            // it is redelivered on a live channel. Never settle it on another channel.
            safe(() => metrics.queueConsumerErrors.inc({ reason: 'delivery_channel_closed' }));
            console.warn(`RabbitMQ ${operation} skipped: delivery channel closed; message will be redelivered.`);
            return false;
          }
          try {
            fn();
            return true;
          } catch (err) {
            console.error(`Error during RabbitMQ ${operation}:`, err.message);
            return false;
          }
        };

        const ack = () => settle('ack', () => deliveryChannel.ack(msg));
        const nack = (requeue = false) => settle('nack', () => deliveryChannel.nack(msg, false, requeue));

        let parsedData;
        try {
          parsedData = JSON.parse(msg.content.toString());
        } catch (parseErr) {
          safe(() => metrics.queueConsumerErrors.inc({ reason: 'malformed_message' }));
          console.error('Malformed JSON message received on queue. Sending to DLQ:', parseErr);
          nack(false); // Nack without requeue -> goes to DLQ
          return;
        }

        const republish = async (delayMs, headers) => {
          if (!isChannelOpen(deliveryChannel)) return settle('retry', () => {});
          try {
            // Publish first, ack second: if the retry publish fails the original message is
            // requeued instead of being lost.
            await this.publishRetry(parsedData, delayMs, headers);
          } catch (err) {
            safe(() => metrics.queueConsumerErrors.inc({ reason: 'retry_publish_failed' }));
            console.error('Error retrying message:', err);
            return nack(true);
          }
          return ack();
        };

        /** Retry after delayMs. extraHeaders: x-documind-* state to carry (e.g. attempt counters). */
        const retry = (delayMs, extraHeaders = {}) => republish(delayMs, extraHeaders);

        // Retried message that came back from the retry queue before its delay elapsed (the
        // queue TTL caps each hop): send it round again without running the handler.
        const carried = ownHeaders(msg);
        if (Number(carried[NOT_BEFORE_HEADER]) > Date.now()) {
          await republish(null, carried);
          return;
        }

        try {
          await handler(msg, parsedData, ack, nack, retry);
        } catch (handlerErr) {
          safe(() => metrics.queueConsumerErrors.inc({ reason: 'handler_exception' }));
          console.error('Unhandled exception in queue consumer handler:', handlerErr);
          nack(false); // Send to DLQ
        }
      },
      { noAck: false }
    );
  }

  /**
   * Ready-message counts for the processing, retry and dead-letter queues.
   * Observability only: uses an already-open connection (never connects) and a dedicated
   * channel, so a failing check cannot close the consumer channel. Returns null if unavailable.
   */
  async getQueueDepths() {
    if (!this.connection) return null;
    try {
      if (!this.monitorChannel) {
        this.monitorChannel = await this.connection.createChannel();
        this.monitorChannel.on('error', () => { this.monitorChannel = null; });
        this.monitorChannel.on('close', () => { this.monitorChannel = null; });
      }
      const queues = { main: env.RABBITMQ_QUEUE, retry: env.RABBITMQ_RETRY_QUEUE, dlq: env.RABBITMQ_DLQ };
      const depths = {};
      for (const [label, name] of Object.entries(queues)) {
        const info = await this.monitorChannel.checkQueue(name);
        depths[label] = info.messageCount;
      }
      return depths;
    } catch (_) {
      this.monitorChannel = null;
      return null;
    }
  }

  /**
   * Graceful close of channel and connection.
   */
  async close() {
    this.closing = true;
    try {
      if (this.monitorChannel) {
        await this.monitorChannel.close().catch(() => {});
        this.monitorChannel = null;
      }
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
    } catch (err) {
      console.error('Error closing RabbitMQ connection:', err.message);
    } finally {
      this.closing = false;
    }
  }
}

module.exports = new RabbitMQService();
module.exports.RETRY_QUEUE_TTL_MS = RETRY_QUEUE_TTL_MS;
module.exports.NOT_BEFORE_HEADER = NOT_BEFORE_HEADER;
module.exports.isChannelOpen = isChannelOpen;
