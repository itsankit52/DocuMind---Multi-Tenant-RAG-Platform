/**
 * Step 10 — Streaming unit tests (no database required)
 *
 *   1. NDJSON incremental parser (split objects, multiple objects per chunk, malformed lines)
 *   2. ollamaService.generateStream over real HTTP against a fake Ollama:
 *      network-level chunk splits, in-stream errors, premature EOF, abort, HTTP errors
 *   3. SSE helper formatting (safe multi-line encoding, heartbeat, event-name validation)
 *   4. SseSession lifecycle (single terminal event, timeout, disconnect, registry cleanup)
 */

const { EventEmitter } = require('events');
const ollamaService = require('../../src/llm/ollama.service');
const sseHelper = require('../../src/sse/sse.helper');
const { SseSession, streamRegistry, ABORT_CODES } = require('../../src/sse/sse-session');
const { startFakeOllama, writeSlowTokens, sleep, waitFor } = require('./fake-ollama');

jest.setTimeout(30000);

// ─────────────────────────────────────────────────────────────────────────────
describe('1. NDJSON incremental parser', () => {
  const collect = () => {
    const items = [];
    return { items, onItem: (i) => items.push(i) };
  };

  it('parses one JSON object per chunk', () => {
    const { items, onItem } = collect();
    const buffer = ollamaService.parseNdjsonChunk('', '{"response":"Hello "}\n', onItem);
    expect(buffer).toBe('');
    expect(items).toEqual([{ response: 'Hello ' }]);
  });

  it('reconstructs one JSON object split across two network chunks', () => {
    const { items, onItem } = collect();
    let buffer = ollamaService.parseNdjsonChunk('', '{"response":"Hel', onItem);
    expect(buffer).toBe('{"response":"Hel');
    expect(items).toEqual([]);
    buffer = ollamaService.parseNdjsonChunk(buffer, 'lo","done":false}\n', onItem);
    expect(buffer).toBe('');
    expect(items).toEqual([{ response: 'Hello', done: false }]);
  });

  it('processes multiple JSON objects arriving in one chunk', () => {
    const { items, onItem } = collect();
    const incoming = '{"response":"Hello","done":false}\n{"response":" world","done":false}\n';
    ollamaService.parseNdjsonChunk('', incoming, onItem);
    expect(items.map(i => i.response).join('')).toBe('Hello world');
  });

  it('keeps an incomplete trailing object while emitting the complete ones', () => {
    const { items, onItem } = collect();
    const buffer = ollamaService.parseNdjsonChunk('', '{"response":"a"}\n{"respo', onItem);
    expect(items).toEqual([{ response: 'a' }]);
    expect(buffer).toBe('{"respo');
  });

  it('skips malformed lines and blank lines without forwarding them', () => {
    const { items, onItem } = collect();
    ollamaService.parseNdjsonChunk('', '\n  \n{not json}\n{"response":"valid"}\n\n', onItem);
    expect(items).toEqual([{ response: 'valid' }]);
  });

  it('propagates errors thrown by the item callback (not swallowed)', () => {
    expect(() => ollamaService.parseNdjsonChunk('', '{"response":"a"}\n', () => {
      throw new Error('callback failure');
    })).toThrow('callback failure');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. ollamaService.generateStream against a fake Ollama HTTP server', () => {
  let fake;
  const originalBaseUrl = ollamaService.baseUrl;

  beforeAll(async () => {
    fake = await startFakeOllama();
    ollamaService.baseUrl = fake.url;
  });
  afterAll(async () => {
    ollamaService.baseUrl = originalBaseUrl;
    await fake.close();
  });

  const run = (opts = {}) => {
    const tokens = [];
    const promise = ollamaService.generateStream({
      userQuestion: 'q',
      contextText: 'ctx',
      onToken: (t) => tokens.push(t),
      ...opts,
    });
    return { tokens, promise };
  };

  it('requests stream:true and reassembles objects split at arbitrary byte boundaries', async () => {
    fake.handler = async (req, res) => {
      const wire = '{"response":"Hel' + '|' + 'lo","done":false}\n{"response":" wor' + '|'
        + 'ld","done":false}\n{"response":"!","done":false}\n{"response":"","done":true,"done_reason":"stop"}\n';
      for (const part of wire.split('|')) {
        res.write(part);
        await sleep(15); // force separate network chunks
      }
      res.end();
    };
    const { tokens, promise } = run();
    const result = await promise;
    expect(fake.requests[fake.requests.length - 1].body.stream).toBe(true);
    expect(tokens.join('')).toBe('Hello world!');
    expect(result).toEqual({ fullAnswer: 'Hello world!', finishReason: 'stop' });
  });

  it('handles a final object without trailing newline and maps done_reason=length', async () => {
    fake.handler = async (req, res) => {
      res.end('{"response":"cut","done":false}\n{"response":"","done":true,"done_reason":"length"}');
    };
    const { promise } = run();
    await expect(promise).resolves.toEqual({ fullAnswer: 'cut', finishReason: 'length' });
  });

  it('rejects when Ollama reports an error inside the stream', async () => {
    fake.handler = async (req, res) => {
      res.end('{"response":"partial","done":false}\n{"error":"model runner crashed"}\n');
    };
    const { tokens, promise } = run();
    await expect(promise).rejects.toThrow(/Ollama stream error/);
    expect(tokens).toEqual(['partial']);
  });

  it('rejects when the stream ends before done:true (truncated upstream)', async () => {
    fake.handler = async (req, res) => res.end('{"response":"half","done":false}\n');
    await expect(run().promise).rejects.toThrow(/ended before generation completed/);
  });

  it('rejects on non-2xx HTTP status', async () => {
    fake.handler = async (req, res) => {
      res.statusCode = 500;
      res.end('{"error":"internal detail"}');
    };
    await expect(run().promise).rejects.toThrow(/Ollama LLM API error \(500\)/);
  });

  it('rejects when the upstream connection drops mid-stream', async () => {
    fake.handler = async (req, res) => {
      res.write('{"response":"a","done":false}\n');
      await sleep(20);
      res.destroy();
    };
    await expect(run().promise).rejects.toThrow();
  });

  it('aborts the upstream HTTP request when the signal fires mid-stream', async () => {
    fake.handler = async (req, res) => writeSlowTokens(res, { delayMs: 20 });
    const controller = new AbortController();
    const { tokens, promise } = run({
      signal: controller.signal,
      onToken: (t) => { tokens.push(t); if (tokens.length === 3) controller.abort(); },
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const record = fake.requests[fake.requests.length - 1];
    expect(await waitFor(() => record.aborted, 3000)).toBe(true);
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run({ signal: controller.signal }).promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
function mockResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.written = '';
  res.writableEnded = false;
  res.destroyed = false;
  res.writable = true;
  res.statusCode = 200;
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.flushHeaders = () => {};
  res.write = (d) => { res.written += d; return true; };
  res.end = () => { res.writableEnded = true; res.emit('finish'); res.emit('close'); };
  return res;
}

describe('3. SSE helper', () => {
  it('formats events as event/data frames with JSON payloads', () => {
    const res = mockResponse();
    sseHelper.sendSseEvent(res, 'token', { text: 'sample' });
    expect(res.written).toBe('event: token\ndata: {"text":"sample"}\n\n');
  });

  it('encodes multi-line and frame-like text safely inside a single data line', () => {
    const res = mockResponse();
    sseHelper.sendSseEvent(res, 'token', { text: 'line1\n\nevent: done\ndata: {}' });
    const frames = res.written.split('\n\n').filter(Boolean);
    expect(frames).toHaveLength(1);
    expect(res.written.split('\n').filter(l => l.startsWith('event:'))).toEqual(['event: token']);
  });

  it('JSON-encodes string payloads too', () => {
    const res = mockResponse();
    sseHelper.sendSseEvent(res, 'token', 'a\nb');
    expect(res.written).toBe('event: token\ndata: "a\\nb"\n\n');
  });

  it('rejects invalid event names', () => {
    expect(() => sseHelper.sendSseEvent(mockResponse(), 'done\ndata: x', {})).toThrow();
  });

  it('formats heartbeat comments and sets anti-buffering headers', () => {
    const res = mockResponse();
    sseHelper.initSseStream(res);
    sseHelper.sendSseHeartbeat(res);
    expect(res.written).toBe(': heartbeat\n\n');
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');
  });

  it('does not write after the response ended', () => {
    const res = mockResponse();
    res.end();
    expect(sseHelper.sendSseEvent(res, 'token', { text: 'x' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. SseSession lifecycle', () => {
  const newSession = (opts = {}) => {
    const res = mockResponse();
    const req = { socket: { destroyed: false } };
    const session = new SseSession(req, res, { heartbeatIntervalMs: 20, timeoutMs: 10000, ...opts });
    session.start();
    return { res, session };
  };

  it('emits exactly one terminal event and ignores anything after it', () => {
    const { res, session } = newSession();
    session.emit('start', {});
    session.emit('done', { finishReason: 'stop' });
    session.emit('token', { text: 'late' });
    session.emit('error', { code: 'X' });
    session.emit('done', {});
    const events = res.written.split('\n').filter(l => l.startsWith('event:'));
    expect(events).toEqual(['event: start', 'event: done']);
    expect(res.writableEnded).toBe(true);
  });

  it('sends heartbeats while open and stops them after close', async () => {
    const { res, session } = newSession({ heartbeatIntervalMs: 10 });
    await sleep(60);
    expect(res.written).toContain(': heartbeat');
    session.end();
    const snapshot = res.written;
    await sleep(40);
    expect(res.written).toBe(snapshot);
  });

  it('aborts with STREAM_TIMEOUT and forces a safe error if the service stays silent', async () => {
    const { res, session } = newSession({ timeoutMs: 20, graceMs: 20 });
    await sleep(100);
    expect(session.signal.aborted).toBe(true);
    expect(session.signal.reason.code).toBe(ABORT_CODES.STREAM_TIMEOUT);
    expect(res.written).toContain('event: error');
    expect(res.written).toContain('STREAM_TIMEOUT');
    expect(res.writableEnded).toBe(true);
  });

  it('aborts with CLIENT_DISCONNECTED when the socket closes early and writes nothing more', () => {
    const { res, session } = newSession();
    res.emit('close'); // socket closed while response not ended
    expect(session.signal.aborted).toBe(true);
    expect(session.signal.reason.code).toBe(ABORT_CODES.CLIENT_DISCONNECTED);
    expect(session.emit('token', { text: 'x' })).toBe(false);
    expect(streamRegistry.activeCount()).toBe(0);
  });

  it('registry tracks active sessions and aborts them on shutdown', () => {
    const { session } = newSession();
    expect(streamRegistry.activeCount()).toBe(1);
    streamRegistry.beginShutdown();
    expect(streamRegistry.isShuttingDown()).toBe(true);
    expect(session.signal.reason.code).toBe(ABORT_CODES.SERVER_SHUTTING_DOWN);
    session.end();
    expect(streamRegistry.activeCount()).toBe(0);
    streamRegistry._reset();
  });

  it('keeps independent state per session (no shared buffers/controllers)', () => {
    const a = newSession();
    const b = newSession();
    a.session.abort(ABORT_CODES.CLIENT_DISCONNECTED);
    expect(a.session.signal.aborted).toBe(true);
    expect(b.session.signal.aborted).toBe(false);
    a.session.end();
    b.session.end();
  });
});
