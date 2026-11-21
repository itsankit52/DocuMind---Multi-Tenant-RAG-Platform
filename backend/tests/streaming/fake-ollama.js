/**
 * Fake Ollama HTTP server + timing utilities for Step 10 streaming tests.
 * Has no dependency on the app, database or Redis.
 */

const http = require('http');

/** Poll until predicate() is truthy (for fire-and-forget side effects). */
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Minimal fake Ollama /api/generate server.
 * Set `fake.handler = async (req, res, body) => {...}` per test.
 * `fake.requests` records each call and whether the client (our backend) aborted it.
 */
async function startFakeOllama() {
  const fake = { requests: [], handler: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const record = { body: JSON.parse(raw || '{}'), aborted: false };
      fake.requests.push(record);
      res.on('close', () => { if (!res.writableEnded) record.aborted = true; });
      res.setHeader('Content-Type', 'application/x-ndjson');
      try {
        await fake.handler(req, res, record.body, record);
      } catch (_) {
        if (!res.writableEnded) res.destroy();
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return fake;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Write NDJSON token lines slowly until the connection closes or `count` is reached. */
async function writeSlowTokens(res, { count = 1000, delayMs = 20, text = 'x' } = {}) {
  for (let i = 0; i < count; i++) {
    if (res.destroyed || res.writableEnded) return;
    res.write(`${JSON.stringify({ response: text, done: false })}\n`);
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end(`${JSON.stringify({ response: '', done: true, done_reason: 'stop' })}\n`);
}

module.exports = { startFakeOllama, writeSlowTokens, waitFor, sleep };
