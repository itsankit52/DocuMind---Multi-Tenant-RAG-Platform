/**
 * SSE client for POST /api/conversations/:id/messages/stream (Step 10 protocol).
 *
 *   event: start     data: { conversationId, userMessageId, replayed? }
 *   event: token     data: { text }
 *   event: citation  data: { id, documentId, chunkId, documentName, chunkIndex, page, relevanceScore }
 *   event: done      data: { conversationId, messageId, finishReason }
 *   event: error     data: { code, message }
 *   ": heartbeat"    comment — ignored
 *
 * EventSource cannot POST or send headers, so the stream is read with fetch().
 * Network chunks are arbitrary: the parser buffers until a blank line ends a frame.
 * An inactivity watchdog aborts the stream when no bytes (heartbeats included) arrive
 * for STREAM_IDLE_TIMEOUT_MS, so a silently dead connection cannot hang the UI.
 */

import {
  API_BASE_URL, getActiveOrganizationId, notifySessionExpired, refreshSession, toApiError, ApiError,
} from './client';

export const STREAM_EVENTS = Object.freeze(['start', 'token', 'citation', 'done', 'error']);
export const STREAM_IDLE_TIMEOUT_MS = 60000;
const INTERRUPTED_MESSAGE = 'The connection was interrupted while generating the answer.';
const IDLE_MESSAGE = 'The server stopped responding while generating the answer. Please try again.';

/**
 * Incremental SSE frame parser.
 * @param {(evt: {event: string, data: object}) => void} onEvent
 * @param {(raw: string) => void} [onMalformed]
 */
export function createSseParser(onEvent, onMalformed = () => {}) {
  let buffer = '';

  const dispatch = (block) => {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue; // blank or comment (heartbeat)
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      onMalformed(raw);
      return;
    }
    if (!data || typeof data !== 'object') {
      onMalformed(raw);
      return;
    }
    onEvent({ event, data });
  };

  let pendingCR = false; // a chunk ended in '\r' whose '\n' may arrive in the next chunk

  return {
    push(text) {
      let chunk = (pendingCR ? '\r' : '') + text;
      pendingCR = chunk.endsWith('\r');
      if (pendingCR) chunk = chunk.slice(0, -1);
      buffer += chunk.replace(/\r\n?/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(block);
        boundary = buffer.indexOf('\n\n');
      }
    },
    /** Dispatch a final frame that arrived without its terminating blank line. */
    flush() {
      if (pendingCR) buffer += '\n';
      pendingCR = false;
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    },
  };
}

function abortError() {
  const err = new ApiError(0, 'Generation stopped.');
  err.name = 'AbortError';
  err.cancelled = true;
  return err;
}

async function openStream(url, init, fetchImpl) {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw abortError();
    throw toApiError(0);
  }
}

/**
 * Stream one chat message. Resolves with the terminal event ('done' | 'error').
 * Rejects with ApiError for pre-stream HTTP failures, interrupted streams, or abort
 * (err.cancelled === true).
 */
export async function streamChatMessage({
  conversationId,
  content,
  signal,
  idempotencyKey,
  onEvent,
  fetchImpl = globalThis.fetch.bind(globalThis),
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
}) {
  const url = `${API_BASE_URL}/conversations/${encodeURIComponent(conversationId)}/messages/stream`;
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const orgId = getActiveOrganizationId();
  if (orgId) headers['X-Organization-Id'] = orgId;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const init = { method: 'POST', headers, body: JSON.stringify({ content }), credentials: 'include', signal };

  let res = await openStream(url, init, fetchImpl);
  if (res.status === 401) {
    // Same contract as the axios client: one shared refresh, else the session has expired
    if (await refreshSession()) res = await openStream(url, init, fetchImpl);
    else notifySessionExpired();
  }

  if (!res.ok) {
    let message;
    try { message = (await res.json())?.message; } catch { /* non-JSON body */ }
    throw toApiError(res.status, message);
  }
  if (!(res.headers.get('content-type') || '').includes('text/event-stream') || !res.body) {
    throw toApiError(500);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let terminal = null;

  // Inactivity watchdog: re-armed on every chunk; cancelling the reader ends a pending read()
  let idleTimer = null;
  let timedOut = false;
  const armWatchdog = () => {
    clearTimeout(idleTimer);
    if (!(idleTimeoutMs > 0)) return;
    idleTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, idleTimeoutMs);
  };

  const parser = createSseParser(
    (evt) => {
      // Nothing after done/error, and nothing once the caller aborted
      if (terminal || signal?.aborted || !STREAM_EVENTS.includes(evt.event)) return;
      if (evt.event === 'done' || evt.event === 'error') terminal = evt;
      onEvent(evt);
    },
    (raw) => { if (import.meta.env.DEV) console.warn('[sse] ignored malformed frame', raw.slice(0, 200)); },
  );

  try {
    armWatchdog();
    while (!terminal) {
      const { done, value } = await reader.read();
      if (timedOut) break;
      if (done) {
        parser.push(decoder.decode());
        parser.flush();
        break;
      }
      armWatchdog();
      parser.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw new ApiError(0, timedOut ? IDLE_MESSAGE : INTERRUPTED_MESSAGE);
  } finally {
    clearTimeout(idleTimer);
    reader.cancel().catch(() => {});
  }

  if (!terminal) {
    if (signal?.aborted) throw abortError();
    throw new ApiError(0, timedOut ? IDLE_MESSAGE : INTERRUPTED_MESSAGE);
  }
  return terminal;
}
