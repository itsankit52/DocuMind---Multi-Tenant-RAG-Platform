/**
 * Server-Sent Events (SSE) Helper Module
 * Provides robust formatting, header initialization, heartbeat keep-alive,
 * and flush mechanics for real-time streaming over HTTP.
 */

// Event names are fixed protocol identifiers — never derived from untrusted input.
const SSE_EVENT_NAME = /^[a-z][a-z_]{0,31}$/;

/**
 * Initializes the HTTP response for SSE streaming.
 * Sets mandatory and anti-buffering headers.
 *
 * @param {import('express').Response} res
 */
function initSseStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx / reverse proxy buffering

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

/**
 * Sends a structured SSE event to the client.
 *
 * Format:
 * event: <eventName>\n
 * data: <JSON string>\n\n
 *
 * @param {import('express').Response} res
 * @param {string} event - Event name (e.g. 'start', 'token', 'citation', 'done', 'error')
 * @param {object|string} data - Payload data to serialize as JSON
 * @returns {boolean} Whether the write succeeded
 */
function sendSseEvent(res, event, data) {
  if (!res || res.writableEnded || res.destroyed || res.writable === false) {
    return false;
  }
  if (typeof event !== 'string' || !SSE_EVENT_NAME.test(event)) {
    throw new Error('Invalid SSE event name.');
  }

  // Always JSON-encode: JSON.stringify escapes newlines, so untrusted text
  // (model output, document names) can never break or inject SSE frames.
  const payload = JSON.stringify(data === undefined ? {} : data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);

  if (typeof res.flush === 'function') {
    res.flush();
  }

  return true;
}

/**
 * Sends an SSE comment or heartbeat ping to maintain the connection through proxies/load balancers.
 *
 * Format:
 * : heartbeat\n\n
 *
 * @param {import('express').Response} res
 * @returns {boolean}
 */
function sendSseHeartbeat(res) {
  if (!res || res.writableEnded || res.destroyed || res.writable === false) {
    return false;
  }

  res.write(': heartbeat\n\n');

  if (typeof res.flush === 'function') {
    res.flush();
  }

  return true;
}

/**
 * Starts a recurring heartbeat timer that pings the client at a regular interval.
 * Automatically clears the interval when the response closes or finishes.
 *
 * @param {import('express').Response} res
 * @param {number} [intervalMs=15000] - Interval between heartbeats in milliseconds
 * @returns {function(): void} - Stops the heartbeat (idempotent)
 */
function startHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || res.writable === false) {
      clearInterval(timer);
      return;
    }
    sendSseHeartbeat(res);
  }, intervalMs);

  const cleanup = () => {
    clearInterval(timer);
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return cleanup;
}

module.exports = {
  initSseStream,
  sendSseEvent,
  sendSseHeartbeat,
  startHeartbeat,
};
