/**
 * Transactional outbox relay.
 *
 * Upload/reprocess write the job + an outbox_events row in one transaction and then try a
 * direct publish. If that publish fails (broker down, process crash between commit and
 * publish) the event stays 'pending'. This relay republishes such events so no document is
 * left in 'uploaded' forever.
 *
 * Only events older than `minAgeSeconds` are picked up, so the relay does not race the
 * direct publish of a request that is still in flight. A duplicate delivery is harmless:
 * the worker's claimJob() lets exactly one delivery process a job.
 */

const { pool } = require('../db');
const outboxRepo = require('../repositories/outbox.repository');
const rabbitmqService = require('./rabbitmq.service');

async function relayPendingOutbox({ limit = 50, minAgeSeconds = 30 } = {}) {
  const client = await pool.connect();
  let published = 0;
  try {
    await client.query('BEGIN');
    const events = await outboxRepo.fetchPendingEvents(client, limit, minAgeSeconds);
    for (const event of events) {
      try {
        await rabbitmqService.publish(event.payload);
      } catch (err) {
        // Broker unavailable: keep the remaining events pending for the next run
        console.warn(`Outbox relay: publish failed for event ${event.id}: ${err.message}`);
        break;
      }
      await outboxRepo.markPublished(client, event.id);
      published++;
    }
    await client.query('COMMIT');
    return published;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Starts a periodic relay loop. Returns a stop() function.
 */
function startOutboxRelay({ intervalMs = 15000, ...options } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const count = await relayPendingOutbox(options);
      if (count > 0) console.log(`Outbox relay: republished ${count} pending event(s)`);
    } catch (err) {
      console.error('Outbox relay run failed:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { relayPendingOutbox, startOutboxRelay };
