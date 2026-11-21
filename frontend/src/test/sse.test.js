import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSseParser, streamChatMessage } from '../api/sse';
import { http, setActiveOrganizationId, setSessionExpiredHandler } from '../api/client';

const enc = new TextEncoder();

/** A fetch Response whose body emits the given string chunks (optionally with delays). */
function sseResponse(chunks, { status = 200, contentType = 'text/event-stream', delayMs = 0 } = {}) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) return controller.close();
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('createSseParser', () => {
  const collect = () => {
    const events = [];
    const malformed = [];
    const parser = createSseParser(e => events.push(e), raw => malformed.push(raw));
    return { events, malformed, parser };
  };

  it('parses a START event', () => {
    const { events, parser } = collect();
    parser.push(frame('start', { conversationId: 'c1', userMessageId: 'u1' }));
    expect(events).toEqual([{ event: 'start', data: { conversationId: 'c1', userMessageId: 'u1' } }]);
  });

  it('parses multiple TOKEN events delivered in one chunk', () => {
    const { events, parser } = collect();
    parser.push(frame('token', { text: 'Hel' }) + frame('token', { text: 'lo' }) + frame('token', { text: '!' }));
    expect(events.map(e => e.data.text).join('')).toBe('Hello!');
  });

  it('reassembles an event split across network chunks, including inside the JSON payload', () => {
    const { events, parser } = collect();
    const wire = frame('token', { text: 'split payload' }) + frame('citation', { documentName: 'a.pdf', page: 2 });
    for (const part of [wire.slice(0, 7), wire.slice(7, 25), wire.slice(25, 40), wire.slice(40)]) parser.push(part);
    expect(events).toEqual([
      { event: 'token', data: { text: 'split payload' } },
      { event: 'citation', data: { documentName: 'a.pdf', page: 2 } },
    ]);
  });

  it('handles byte-by-byte delivery and CRLF line endings', () => {
    const { events, parser } = collect();
    const wire = 'event: done\r\ndata: {"messageId":"m1","finishReason":"stop"}\r\n\r\n';
    for (const ch of wire) parser.push(ch);
    expect(events).toEqual([{ event: 'done', data: { messageId: 'm1', finishReason: 'stop' } }]);
  });

  it('ignores heartbeat comments and keeps an incomplete frame buffered until flush', () => {
    const { events, parser } = collect();
    parser.push(': heartbeat\n\n');
    parser.push('event: error\ndata: {"code":"X","message":"m"}');
    expect(events).toEqual([]);
    parser.flush();
    expect(events).toEqual([{ event: 'error', data: { code: 'X', message: 'm' } }]);
  });

  it('skips malformed frames without breaking later ones', () => {
    const { events, malformed, parser } = collect();
    parser.push('event: token\ndata: {not json\n\n' + 'event: token\ndata: 42\n\n' + frame('token', { text: 'ok' }));
    expect(malformed).toHaveLength(2);
    expect(events).toEqual([{ event: 'token', data: { text: 'ok' } }]);
  });
});

describe('streamChatMessage', () => {
  beforeEach(() => setActiveOrganizationId('org-1'));

  it('sends the POST with tenant header and streams START → TOKEN* → CITATION → DONE in order', async () => {
    const wire = frame('start', { conversationId: 'c1', userMessageId: 'u1' })
      + frame('token', { text: 'The' }) + frame('token', { text: ' answer' })
      + frame('citation', { id: 'x', documentName: 'policy.pdf', page: 1, chunkIndex: 0 })
      + frame('done', { conversationId: 'c1', messageId: 'a1', finishReason: 'stop' });
    // Cut at arbitrary offsets to emulate network chunking
    const chunks = [wire.slice(0, 13), wire.slice(13, 90), wire.slice(90, 91), wire.slice(91)];
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(chunks, { delayMs: 1 }));
    const events = [];

    const terminal = await streamChatMessage({ conversationId: 'c1', content: 'Q?', onEvent: e => events.push(e), fetchImpl, idempotencyKey: 'k1' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/conversations/c1/messages/stream');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers['X-Organization-Id']).toBe('org-1');
    expect(init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(init.body)).toEqual({ content: 'Q?' });
    expect(events.map(e => e.event)).toEqual(['start', 'token', 'token', 'citation', 'done']);
    expect(terminal.event).toBe('done');
  });

  it('resolves with an ERROR terminal event and ignores anything after it', async () => {
    const wire = frame('start', {}) + frame('token', { text: 'partial' })
      + frame('error', { code: 'LLM_STREAM_ERROR', message: 'Unable to generate a response.' })
      + frame('token', { text: 'late' }) + frame('done', { messageId: 'x' });
    const events = [];
    const terminal = await streamChatMessage({
      conversationId: 'c1', content: 'Q', onEvent: e => events.push(e), fetchImpl: vi.fn().mockResolvedValue(sseResponse([wire])),
    });
    expect(terminal).toEqual({ event: 'error', data: { code: 'LLM_STREAM_ERROR', message: 'Unable to generate a response.' } });
    expect(events.map(e => e.event)).toEqual(['start', 'token', 'error']);
  });

  it('maps pre-stream HTTP errors to safe ApiErrors (no stream events)', async () => {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const onEvent = vi.fn();

    await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent,
      fetchImpl: vi.fn().mockResolvedValue(json(429, { message: 'Too many requests' })) }))
      .rejects.toMatchObject({ status: 429, message: 'Too many requests. Please wait a moment and try again.' });

    await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent,
      fetchImpl: vi.fn().mockResolvedValue(json(500, { message: 'db down', stack: 'Error at x.js:1' })) }))
      .rejects.toMatchObject({ status: 500, message: 'Something went wrong on the server. Please try again.' });

    await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent,
      fetchImpl: vi.fn().mockResolvedValue(json(404, { message: 'Conversation not found.' })) }))
      .rejects.toMatchObject({ status: 404, message: 'Conversation not found.' });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects when the connection ends before DONE/ERROR', async () => {
    await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent: () => {},
      fetchImpl: vi.fn().mockResolvedValue(sseResponse([frame('start', {}), frame('token', { text: 'a' })])) }))
      .rejects.toThrow(/interrupted/);
  });

  it('rejects with a network ApiError when fetch fails', async () => {
    await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent: () => {},
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }))
      .rejects.toMatchObject({ status: 0 });
  });

  it('AbortController cancellation stops delivery immediately and rejects as cancelled', async () => {
    const controller = new AbortController();
    let bodyErrored = false;
    // Like real fetch: aborting the signal errors the response body stream
    const fetchImpl = vi.fn((url, init) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(frame('start', {}) + frame('token', { text: 'one' }) + frame('token', { text: 'two' })));
          init.signal.addEventListener('abort', () => {
            bodyErrored = true;
            c.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    });
    const events = [];

    await expect(streamChatMessage({
      conversationId: 'c', content: 'q', signal: controller.signal, fetchImpl,
      onEvent: (e) => { events.push(e); if (e.event === 'token') controller.abort(); },
    })).rejects.toMatchObject({ cancelled: true, name: 'AbortError' });

    // 'two' was already in the buffer but must not be delivered after abort
    expect(events.map(e => e.data.text || e.event)).toEqual(['start', 'one']);
    expect(bodyErrored).toBe(true);
  });

  it('when the stream is 401 and the cookie refresh fails, the session-expired handler runs', async () => {
    const originalAdapter = http.defaults.adapter;
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    http.defaults.adapter = async (config) => {
      const err = new Error('status 401');
      err.response = { status: 401, data: {}, headers: {}, config, statusText: '' };
      err.config = config;
      throw err;
    };
    try {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
      await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent: () => {}, fetchImpl }))
        .rejects.toMatchObject({ status: 401 });
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry without a refreshed session
      expect(expired).toHaveBeenCalledTimes(1);
    } finally {
      http.defaults.adapter = originalAdapter;
      setSessionExpiredHandler(null);
    }
  });

  it('aborts with a clear error when no bytes arrive within the inactivity timeout', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(c) { c.enqueue(enc.encode(frame('start', {}) + frame('token', { text: 'a' }))); }, // then silence
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const events = [];
    await expect(streamChatMessage({ conversationId: 'c', content: 'q', onEvent: e => events.push(e), fetchImpl, idleTimeoutMs: 30 }))
      .rejects.toMatchObject({ status: 0, message: expect.stringMatching(/stopped responding/) });
    expect(events.map(e => e.event)).toEqual(['start', 'token']);
    expect(cancelled).toBe(true);
  });

  it('heartbeats keep a slow stream alive past the inactivity timeout', async () => {
    const heartbeat = ': heartbeat\n\n';
    const chunks = [frame('start', {}), ...Array(6).fill(heartbeat), frame('done', { messageId: 'm' })]; // ~160ms total
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(chunks, { delayMs: 20 }));
    const terminal = await streamChatMessage({ conversationId: 'c', content: 'q', onEvent: () => {}, fetchImpl, idleTimeoutMs: 100 });
    expect(terminal.event).toBe('done');
  });

  it('an already-aborted signal rejects as cancelled without delivering events', async () => {
    const controller = new AbortController();
    controller.abort();
    const onEvent = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(streamChatMessage({ conversationId: 'c', content: 'q', signal: controller.signal, onEvent, fetchImpl }))
      .rejects.toMatchObject({ cancelled: true });
    expect(onEvent).not.toHaveBeenCalled();
  });
});
