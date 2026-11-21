/**
 * SSE Session
 * Owns the transport lifecycle of ONE streaming HTTP response:
 *
 *   - SSE headers, heartbeat keep-alive
 *   - a per-request AbortController (never shared between requests)
 *   - client-disconnect detection  -> abort(CLIENT_DISCONNECTED)
 *   - overall stream timeout       -> abort(STREAM_TIMEOUT)
 *   - server shutdown              -> abort(SERVER_SHUTTING_DOWN)
 *   - terminal-event guarantee: exactly one `done` OR `error`, nothing after it
 *
 * Business logic (RAG, persistence) lives in chat-stream.service.js and talks to
 * the client only through session.emit().
 */

const { initSseStream, sendSseEvent, startHeartbeat } = require('./sse.helper');
const { metrics, safe, secondsSince, boundedLabel } = require('../observability/metrics');

const ABORT_CODES = Object.freeze({
  CLIENT_DISCONNECTED: 'CLIENT_DISCONNECTED',
  STREAM_TIMEOUT: 'STREAM_TIMEOUT',
  SERVER_SHUTTING_DOWN: 'SERVER_SHUTTING_DOWN',
});

// Safe, client-facing messages for transport-level terminations.
const ABORT_MESSAGES = Object.freeze({
  STREAM_TIMEOUT: 'The response took too long and was stopped.',
  SERVER_SHUTTING_DOWN: 'The server is restarting. Please retry shortly.',
});

const TERMINAL_EVENTS = new Set(['done', 'error']);

// ─── Active stream registry (graceful shutdown) ───────────────────────────────
const activeSessions = new Set();
let shuttingDown = false;

const streamRegistry = {
  isShuttingDown: () => shuttingDown,
  activeCount: () => activeSessions.size,
  /** Stop accepting new streams and abort all in-flight ones. */
  beginShutdown() {
    shuttingDown = true;
    for (const session of activeSessions) {
      session.abort(ABORT_CODES.SERVER_SHUTTING_DOWN);
    }
  },
  /** Test hook: re-open the registry after a simulated shutdown. */
  _reset() {
    shuttingDown = false;
  },
};

class SseSession {
  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {object} options
   * @param {number} options.heartbeatIntervalMs
   * @param {number} options.timeoutMs      - Hard limit for the whole stream
   * @param {number} [options.graceMs=5000] - After an abort, how long the service may take
   *                                          to emit its own terminal event before we force one
   */
  constructor(req, res, { heartbeatIntervalMs, timeoutMs, graceMs = 5000 }) {
    this.req = req;
    this.res = res;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.timeoutMs = timeoutMs;
    this.graceMs = graceMs;

    this.controller = new AbortController();
    this.terminated = false;
    this.closed = false;
    this.stopHeartbeat = null;
    this.timeoutTimer = null;
    this.graceTimer = null;
    this.startedAt = null;
    this.outcome = null;

    this.emit = this.emit.bind(this);
    this._onClose = this._onClose.bind(this);
  }

  get signal() {
    return this.controller.signal;
  }

  /** Commit SSE headers. After this, errors can only be reported as SSE `error` events. */
  start() {
    this.res.on('close', this._onClose);
    activeSessions.add(this);

    // Client may have vanished while pre-stream checks were running
    if (this.res.destroyed || (this.req.socket && this.req.socket.destroyed)) {
      this._onClose();
      return;
    }

    initSseStream(this.res);
    this.startedAt = process.hrtime.bigint();
    safe(() => metrics.sseStreamsStarted.inc());
    this.stopHeartbeat = startHeartbeat(this.res, this.heartbeatIntervalMs);
    this.timeoutTimer = setTimeout(() => this.abort(ABORT_CODES.STREAM_TIMEOUT), this.timeoutMs);
  }

  /**
   * Send one application event. Ignored once a terminal event was sent or the client left.
   * `done` / `error` end the response.
   *
   * @returns {boolean} whether the event was written
   */
  emit(event, data) {
    if (this.terminated || this.closed) return false;

    const written = sendSseEvent(this.res, event, data);
    if (TERMINAL_EVENTS.has(event)) {
      this._recordOutcome(event, data);
      this.terminated = true;
      this._finish();
    }
    return written;
  }

  /**
   * Abort the stream: cancels upstream work through the AbortSignal.
   * The service is expected to emit the matching terminal event; if it does not
   * within graceMs, a safe `error` event is forced so the response never hangs.
   */
  abort(code) {
    if (this.controller.signal.aborted) return;
    const reason = new Error(`Stream aborted: ${code}`);
    reason.code = code;
    this.controller.abort(reason);

    if (code === ABORT_CODES.CLIENT_DISCONNECTED) return; // nobody left to notify

    this.graceTimer = setTimeout(() => {
      this.emit('error', { code, message: ABORT_MESSAGES[code] || 'The stream was stopped.' });
    }, this.graceMs);
  }

  /** Ensure the response is closed and all resources are released. Idempotent. */
  end() {
    if (!this.terminated && !this.closed) {
      this.terminated = true;
    }
    this._finish();
  }

  _onClose() {
    if (!this.res.writableEnded) {
      // Socket closed before we finished the response -> client disconnected
      this.closed = true;
      this._recordOutcome('disconnect');
      this.abort(ABORT_CODES.CLIENT_DISCONNECTED);
    }
    this._cleanup();
  }

  _finish() {
    this._cleanup();
    if (!this.res.writableEnded && !this.res.destroyed) {
      this.res.end();
    }
  }

  /** Metrics only: record how the stream ended, exactly once. Never throws. */
  _recordOutcome(event, data) {
    if (this.outcome || !this.startedAt) return;
    const code = data && data.code;
    let outcome = 'completed';
    if (event === 'disconnect') outcome = 'client_disconnected';
    else if (event === 'error') {
      outcome = code === ABORT_CODES.STREAM_TIMEOUT ? 'timeout'
        : code === ABORT_CODES.SERVER_SHUTTING_DOWN ? 'shutdown' : 'error';
    }
    this.outcome = outcome;
    safe(() => {
      metrics.sseStreams.inc({ outcome });
      metrics.sseStreamDuration.observe({ outcome }, secondsSince(this.startedAt));
      if (event === 'error') metrics.sseStreamErrors.inc({ code: boundedLabel(code) });
    });
  }

  _cleanup() {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.stopHeartbeat) this.stopHeartbeat();
    this.timeoutTimer = null;
    this.graceTimer = null;
    this.stopHeartbeat = null;
    activeSessions.delete(this);
  }
}

module.exports = {
  SseSession,
  streamRegistry,
  ABORT_CODES,
  ABORT_MESSAGES,
};
