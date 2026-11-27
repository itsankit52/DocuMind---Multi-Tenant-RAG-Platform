/**
 * Regression tests for worker/RabbitMQ reliability (audit batch 1):
 *  - C4: deliveries are settled only on the channel that delivered them; a closed delivery
 *    channel is never "settled" on its replacement and never throws
 *  - C18: retry delays longer than the retry queue's 5 s TTL are honoured (multi-hop) without
 *    changing the durable queue's arguments; job-lookup DB errors are retried a bounded number
 *    of times and then dead-lettered
 * Real-broker tests use only the isolated test queues (RABBITMQ_QUEUE etc. must contain "test").
 */

const { EventEmitter } = require('events');
const env = require('../../src/config/env');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const DocumentProcessor = require('../../src/workers/processor');
const jobRepo = require('../../src/repositories/job.repository');
const { pool } = require('../../src/db');
const { metricValue } = require('../observability/obs.helpers');

const { RETRY_QUEUE_TTL_MS, NOT_BEFORE_HEADER, isChannelOpen } = rabbitmqService;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 20000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fakeChannel() {
  const ch = new EventEmitter();
  ch.ack = jest.fn();
  ch.nack = jest.fn();
  ch.prefetch = jest.fn(async () => {});
  ch.consume = jest.fn(async (queue, cb) => { ch.deliver = cb; return { consumerTag: 'ctag' }; });
  ch.sendToQueue = jest.fn(() => true);
  ch.waitForConfirms = jest.fn(async () => {});
  ch.assertQueue = jest.fn(async () => {});
  return ch;
}

const fakeMsg = (body, headers = {}) => ({
  content: Buffer.from(JSON.stringify(body)),
  fields: { deliveryTag: 1, redelivered: false },
  properties: { headers },
});

afterAll(async () => {
  await rabbitmqService.close().catch(() => {});
  await pool.end();
});

describe('C4 — settle on the delivery channel (fake channels)', () => {
  let ch1;
  let ch2;

  beforeEach(() => {
    ch1 = fakeChannel();
    ch2 = fakeChannel();
    jest.spyOn(rabbitmqService, 'connect').mockResolvedValue({});
    rabbitmqService.connection = {};
    rabbitmqService.channel = ch1;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rabbitmqService.connection = null;
    rabbitmqService.channel = null;
  });

  test('ack goes to the delivering channel even after this.channel was replaced', async () => {
    let result;
    await rabbitmqService.consume(async (msg, data, ack) => {
      rabbitmqService.channel = ch2; // reconnect happened while the handler ran
      result = ack();
    });
    const msg = fakeMsg({ jobId: 'a' });
    await ch1.deliver(msg);
    expect(result).toBe(true);
    expect(ch1.ack).toHaveBeenCalledWith(msg);
    expect(ch2.ack).not.toHaveBeenCalled();
  });

  test('ack/nack/retry on a closed delivery channel are skipped, never routed elsewhere, never throw', async () => {
    const before = await metricValue('queue_consumer_errors_total', { reason: 'delivery_channel_closed' });
    const results = {};
    await rabbitmqService.consume(async (msg, data, ack, nack, retry) => {
      ch1.emit('close'); // connection dropped mid-handler
      rabbitmqService.channel = ch2; // ...and was replaced
      results.ack = ack();
      results.nack = nack(false);
      results.retry = await retry(8000);
    });
    await expect(ch1.deliver(fakeMsg({ jobId: 'b' }))).resolves.toBeUndefined();
    expect(results).toEqual({ ack: false, nack: false, retry: false });
    expect(isChannelOpen(ch1)).toBe(false);
    for (const ch of [ch1, ch2]) {
      expect(ch.ack).not.toHaveBeenCalled();
      expect(ch.nack).not.toHaveBeenCalled();
      expect(ch.sendToQueue).not.toHaveBeenCalled(); // no retry copy: the broker redelivers the original
    }
    expect(await metricValue('queue_consumer_errors_total', { reason: 'delivery_channel_closed' })).toBe(before + 3);
  });

  test('retry publishes on the live channel, then acks on the delivery channel', async () => {
    await rabbitmqService.consume(async (msg, data, ack, nack, retry) => {
      rabbitmqService.channel = ch2;
      await retry(2000);
    });
    const msg = fakeMsg({ jobId: 'c' });
    await ch1.deliver(msg);
    expect(ch2.sendToQueue).toHaveBeenCalledWith(env.RABBITMQ_RETRY_QUEUE, expect.any(Buffer), expect.any(Object));
    expect(ch1.ack).toHaveBeenCalledWith(msg);
    expect(ch2.ack).not.toHaveBeenCalled();
  });

  test('handler exceptions and malformed messages are nacked (dead-lettered) on the delivery channel', async () => {
    await rabbitmqService.consume(async () => { throw new Error('boom'); });
    const bad = { content: Buffer.from('{not json'), fields: { deliveryTag: 2 }, properties: {} };
    const good = fakeMsg({ jobId: 'd' });
    await ch1.deliver(bad);
    await ch1.deliver(good);
    expect(ch1.nack).toHaveBeenCalledWith(bad, false, false);
    expect(ch1.nack).toHaveBeenCalledWith(good, false, false);
  });
});

describe('C18 — retry delays vs the retry queue TTL (fake channels)', () => {
  let ch;

  beforeEach(() => {
    ch = fakeChannel();
    jest.spyOn(rabbitmqService, 'connect').mockResolvedValue({});
    rabbitmqService.connection = {};
    rabbitmqService.channel = ch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rabbitmqService.connection = null;
    rabbitmqService.channel = null;
  });

  test('the durable retry queue keeps its existing arguments (no PRECONDITION_FAILED on deploy)', async () => {
    await rabbitmqService.setupTopology();
    const retryDecl = ch.assertQueue.mock.calls.find(([name]) => name === env.RABBITMQ_RETRY_QUEUE);
    expect(retryDecl[1]).toEqual({
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': env.RABBITMQ_QUEUE,
        'x-message-ttl': 5000,
      },
    });
    expect(RETRY_QUEUE_TTL_MS).toBe(5000);
  });

  test('a long delay is recorded as not-before; each hop is capped at the queue TTL', async () => {
    const start = Date.now();
    await rabbitmqService.publishRetry({ jobId: 'e' }, 20000, { 'x-documind-lookup-attempts': 2 });
    const [, , opts] = ch.sendToQueue.mock.calls[0];
    expect(opts.expiration).toBe(String(RETRY_QUEUE_TTL_MS));
    expect(opts.headers[NOT_BEFORE_HEADER]).toBeGreaterThanOrEqual(start + 20000);
    expect(opts.headers['x-documind-lookup-attempts']).toBe(2);

    await rabbitmqService.publishRetry({ jobId: 'f' }, 2000);
    expect(ch.sendToQueue.mock.calls[1][2].expiration).toBe('2000');
  });

  test('a message that returns before its not-before time is sent round again, not processed', async () => {
    const handler = jest.fn();
    await rabbitmqService.consume(handler);
    const notBefore = Date.now() + 9000;
    const early = fakeMsg({ jobId: 'g' }, { [NOT_BEFORE_HEADER]: notBefore, 'x-death': [{ count: 1 }], 'x-documind-lookup-attempts': 1 });
    await ch.deliver(early);
    expect(handler).not.toHaveBeenCalled();
    const [queue, , opts] = ch.sendToQueue.mock.calls[0];
    expect(queue).toBe(env.RABBITMQ_RETRY_QUEUE);
    expect(opts.headers).toEqual({ [NOT_BEFORE_HEADER]: notBefore, 'x-documind-lookup-attempts': 1 }); // x-death dropped
    expect(Number(opts.expiration)).toBeLessThanOrEqual(RETRY_QUEUE_TTL_MS);
    expect(ch.ack).toHaveBeenCalledWith(early);

    const due = fakeMsg({ jobId: 'h' }, { [NOT_BEFORE_HEADER]: Date.now() - 1 });
    await ch.deliver(due);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('C18 — bounded retries for job-lookup database errors', () => {
  afterEach(() => jest.restoreAllMocks());

  // organizationId is required since Phase 3.4 (the lookup runs in that tenant's transaction)
  const payload = { jobId: '0190f7a2-0000-7000-8000-0000000000a1', documentId: '0190f7a2-0000-7000-8000-0000000000d1', organizationId: '0190f7a2-0000-7000-8000-0000000000f1' };

  test('backs off, then dead-letters after JOB_LOOKUP_MAX_ATTEMPTS and acks', async () => {
    jest.spyOn(jobRepo, 'findById').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5433'));
    const dlq = jest.spyOn(rabbitmqService, 'publishDeadLetter').mockResolvedValue(true);
    const processor = new DocumentProcessor('lookup-test');
    const max = env.JOB_LOOKUP_MAX_ATTEMPTS;

    let headers = {};
    const delays = [];
    let final;
    for (let i = 0; i < max + 2; i++) {
      const c = { ack: jest.fn(), nack: jest.fn(), retry: jest.fn(), headers };
      await processor.processJob(payload, c);
      if (c.retry.mock.calls.length) {
        const [delayMs, nextHeaders] = c.retry.mock.calls[0];
        delays.push(delayMs);
        headers = { ...headers, ...nextHeaders };
      } else {
        final = c;
        break;
      }
    }

    expect(delays).toEqual(Array.from({ length: max - 1 }, (_, i) => Math.min(60000, 3000 * 2 ** i)));
    expect(final.ack).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveBeenCalledTimes(1);
    expect(dlq.mock.calls[0][1]).toMatch(new RegExp(`lookup failed after ${max} attempts`));
  });

  test('if dead-lettering itself fails, the error propagates so the consumer nacks to the DLX', async () => {
    jest.spyOn(jobRepo, 'findById').mockRejectedValue(new Error('db down'));
    jest.spyOn(rabbitmqService, 'publishDeadLetter').mockRejectedValue(new Error('broker down'));
    const c = { ack: jest.fn(), nack: jest.fn(), retry: jest.fn(), headers: { 'x-documind-lookup-attempts': env.JOB_LOOKUP_MAX_ATTEMPTS } };
    await expect(new DocumentProcessor('lookup-test').processJob(payload, c)).rejects.toThrow('broker down');
    expect(c.ack).not.toHaveBeenCalled();
  });
});

describe('Real broker (isolated test queues)', () => {
  beforeAll(async () => {
    for (const q of [env.RABBITMQ_QUEUE, env.RABBITMQ_RETRY_QUEUE]) {
      if (!/test/i.test(q)) throw new Error(`Refusing to purge non-test queue "${q}"`);
    }
    await rabbitmqService.connect();
    await rabbitmqService.channel.purgeQueue(env.RABBITMQ_QUEUE);
    await rabbitmqService.channel.purgeQueue(env.RABBITMQ_RETRY_QUEUE);
  });

  afterEach(async () => {
    await rabbitmqService.close();
  });

  test('channel replacement while a handler runs: stale ack is skipped, replacement stays open, message is redelivered', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    let staleAckResult;
    const firstDeliveries = [];

    await rabbitmqService.consume(async (msg, data, ack) => {
      firstDeliveries.push(data.probe);
      await gate; // long-running job
      staleAckResult = ack();
    });
    await rabbitmqService.publish({ probe: 'p1' });
    await waitFor(() => firstDeliveries.length === 1, 10000, 'first delivery');

    // Connection drops mid-job; the worker reconnects and re-subscribes on a new channel
    const oldChannel = rabbitmqService.channel;
    await rabbitmqService.connection.close();
    await rabbitmqService.connect();
    const newChannel = rabbitmqService.channel;
    expect(newChannel).not.toBe(oldChannel);
    const newAck = jest.spyOn(newChannel, 'ack');
    let newChannelClosed = false;
    newChannel.on('close', () => { newChannelClosed = true; });

    const redeliveries = [];
    await rabbitmqService.consume(async (msg, data, ack) => {
      redeliveries.push({ probe: data.probe, redelivered: msg.fields.redelivered });
      ack();
    });
    await waitFor(() => redeliveries.length === 1, 10000, 'redelivery on the new channel');
    expect(redeliveries[0]).toEqual({ probe: 'p1', redelivered: true }); // unacked delivery was recoverable

    release(); // the old handler finishes and tries to ack its old delivery tag
    await sleep(500);
    expect(staleAckResult).toBe(false);
    expect(newAck).toHaveBeenCalledTimes(1); // only the new handler's own ack
    expect(newChannelClosed).toBe(false); // no 406 PRECONDITION_FAILED
    expect(rabbitmqService.channel).toBe(newChannel);
    expect((await rabbitmqService.getQueueDepths()).main).toBe(0);
  }, 30000);

  test('a retry delay longer than the queue TTL is honoured (not cut to 5 s)', async () => {
    const delayMs = 12000;
    let arrivedAt = null;
    await rabbitmqService.consume(async (msg, data, ack) => {
      if (data.probe === 'delayed') arrivedAt = Date.now();
      ack();
    });
    const sentAt = Date.now();
    await rabbitmqService.publishRetry({ probe: 'delayed' }, delayMs);
    await waitFor(() => arrivedAt !== null, delayMs + 15000, 'delayed delivery');
    const elapsed = arrivedAt - sentAt;
    expect(elapsed).toBeGreaterThanOrEqual(delayMs);
    expect(elapsed).toBeLessThan(delayMs + RETRY_QUEUE_TTL_MS + 3000);
  }, 40000);
});
