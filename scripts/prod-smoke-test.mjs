#!/usr/bin/env node
/**
 * DocuMind production smoke test — exercises the stack ONLY through the public Nginx entry point.
 *
 *   node scripts/prod-smoke-test.mjs [baseUrl]      (default http://localhost:8080)
 *
 * Creates fresh, uniquely-named users/organizations (never touches existing data), uploads a
 * generated PDF, waits for processing, runs RAG + SSE chat, and checks RBAC / tenant isolation.
 * Requires Node >= 20 (global fetch/FormData/Blob). Exit code 1 if any check fails.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const RUN = Date.now().toString(36);
const FACT_CODE = `AURORA-${Math.floor(1000 + Math.random() * 9000)}`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return Boolean(ok);
}

async function api(method, url, { token, org, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (org) h['X-Organization-Id'] = org;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, { method, headers: h, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function makePdf() {
  const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../backend/package.json'));
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'DocuMind Deployment Handbook',
    `The production release codename for DocuMind is ${FACT_CODE}.`,
    `Release ${FACT_CODE} is deployed behind an Nginx reverse proxy.`,
    'The on-call rotation for the deployment team changes every Monday at 09:00.',
  ];
  lines.forEach((t, i) => page.drawText(t, { x: 50, y: 750 - i * 24, size: 12, font }));
  return Buffer.from(await doc.save());
}

async function registerAndLogin(label) {
  const email = `smoke-${label}-${RUN}@example.test`;
  const password = `Smoke!${RUN}Pw#2026`;
  const reg = await api('POST', '/api/auth/register', { body: { email, password, fullName: `Smoke ${label}` } });
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  return { email, reg, login, token: login.json?.data?.accessToken, cookies: login.headers.getSetCookie?.() || [] };
}

async function streamChat(token, org, conversationId, content) {
  const t0 = performance.now();
  const res = await api('POST', `/api/conversations/${conversationId}/messages/stream`, {
    token, org, raw: true, body: { content }, headers: { Accept: 'text/event-stream' },
  });
  const out = { status: res.status, contentType: res.headers.get('content-type'), events: [], tokenTimes: [], chunks: 0, text: '' };
  if (!res.body || res.status !== 200) return out;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.chunks += 1;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!ev) continue;
      const parsed = data ? JSON.parse(data) : null;
      out.events.push({ ev, data: parsed, t: performance.now() - t0 });
      if (ev === 'token') { out.tokenTimes.push(performance.now() - t0); out.text += parsed.text; }
    }
  }
  out.totalMs = performance.now() - t0;
  return out;
}

async function main() {
  console.log(`DocuMind production smoke test → ${BASE}  (run ${RUN})\n`);

  // ── Nginx / frontend / health ──────────────────────────────────────────────
  const home = await api('GET', '/');
  check('Frontend served by Nginx (GET /)', home.status === 200 && home.text.includes('<div id="root">'));
  const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(home.text)?.[1];
  const asset = assetPath ? await api('GET', assetPath) : { status: 0, headers: new Headers() };
  check('Static JS bundle served (production build, immutable cache)', asset.status === 200 && /immutable/.test(asset.headers.get('cache-control') || ''), assetPath);
  check('Security headers present (CSP, XFO, nosniff, Referrer-Policy)',
    ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy'].every(h => home.headers.get(h)));
  const spa = await api('GET', '/documents/some/deep/link');
  check('SPA deep-link fallback returns index.html', spa.status === 200 && spa.text.includes('<div id="root">'));
  check('Nginx health endpoint', (await api('GET', '/nginx-health')).status === 200);
  const live = await api('GET', '/health/live');
  check('API liveness through Nginx', live.status === 200 && live.json?.status === 'alive');
  check('/metrics NOT publicly exposed', (await api('GET', '/metrics')).status === 404);
  check('/health/ready detail NOT publicly exposed', (await api('GET', '/health/ready')).status === 404);
  const rid = `smoke-${RUN}`;
  const ridRes = await api('GET', '/api/auth/me', { headers: { 'X-Request-Id': rid } });
  check('X-Request-Id propagated client → Nginx → API → response', ridRes.headers.get('x-request-id') === rid);
  const genRid = await api('GET', '/health/live');
  check('Request ID generated when absent', /^[A-Za-z0-9._:-]{8,}$/.test(genRid.headers.get('x-request-id') || ''));

  // ── Auth ───────────────────────────────────────────────────────────────────
  const adminA = await registerAndLogin('admina');
  const memberA = await registerAndLogin('membera');
  const viewerA = await registerAndLogin('viewera');
  const adminB = await registerAndLogin('adminb');
  check('Registration', [adminA, memberA, viewerA, adminB].every(u => u.reg.status === 201));
  check('Login returns access token', [adminA, memberA, viewerA, adminB].every(u => u.login.status === 200 && u.token));
  const accessCookie = adminA.cookies.find(c => c.startsWith('accessToken=')) || '';
  check('Auth cookie flags: HttpOnly; Secure; SameSite=Strict',
    /HttpOnly/i.test(accessCookie) && /Secure/i.test(accessCookie) && /SameSite=Strict/i.test(accessCookie), accessCookie.replace(/=[^;]+/, '=<redacted>'));
  const me = await api('GET', '/api/auth/me', { token: adminA.token });
  check('GET /api/auth/me (authenticated)', me.status === 200);
  check('Unauthenticated API request rejected', (await api('GET', '/api/documents')).status === 401);
  check('Invalid JWT rejected', (await api('GET', '/api/auth/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid' })).status === 401);
  const wrongPw = await api('POST', '/api/auth/login', { body: { email: adminA.email, password: 'wrong-password-123' } });
  check('Wrong password rejected', wrongPw.status === 401 || wrongPw.status === 400, `status ${wrongPw.status}`);

  // ── Organizations / RBAC setup ─────────────────────────────────────────────
  const orgA = (await api('POST', '/api/organizations', { token: adminA.token, body: { name: `Smoke A ${RUN}`, slug: `smoke-a-${RUN}` } })).json?.data?.org?.id;
  const orgB = (await api('POST', '/api/organizations', { token: adminB.token, body: { name: `Smoke B ${RUN}`, slug: `smoke-b-${RUN}` } })).json?.data?.org?.id;
  check('Create organizations (creator becomes admin)', orgA && orgB);
  const tenantA = await api('POST', `/api/organizations/${orgA}/select`, { token: adminA.token });
  check('Admin role resolved for creator', tenantA.json?.data?.role === 'admin');
  const addM = await api('POST', `/api/organizations/${orgA}/members`, { token: adminA.token, org: orgA, body: { email: memberA.email, role: 'member' } });
  const addV = await api('POST', `/api/organizations/${orgA}/members`, { token: adminA.token, org: orgA, body: { email: viewerA.email, role: 'viewer' } });
  check('Admin adds Member and Viewer', [200, 201].includes(addM.status) && [200, 201].includes(addV.status), `${addM.status}/${addV.status}`);
  check('Viewer cannot call admin endpoint (add member)',
    (await api('POST', `/api/organizations/${orgA}/members`, { token: viewerA.token, org: orgA, body: { email: adminB.email, role: 'viewer' } })).status === 403);
  check('Member cannot call admin endpoint (add member)',
    (await api('POST', `/api/organizations/${orgA}/members`, { token: memberA.token, org: orgA, body: { email: adminB.email, role: 'viewer' } })).status === 403);

  // ── Documents ──────────────────────────────────────────────────────────────
  const pdf = await makePdf();
  const form = () => { const f = new FormData(); f.append('file', new Blob([pdf], { type: 'application/pdf' }), `handbook-${RUN}.pdf`); return f; };
  check('Viewer cannot upload', (await api('POST', '/api/documents', { token: viewerA.token, org: orgA, body: form() })).status === 403);
  const up = await api('POST', '/api/documents', { token: memberA.token, org: orgA, body: form() });
  const docId = up.json?.data?.document?.id || up.json?.data?.doc?.id || up.json?.data?.id;
  check('Member uploads PDF through Nginx', [201, 202].includes(up.status) && docId, `status ${up.status}`);

  let status = null;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const d = await api('GET', `/api/documents/${docId}`, { token: viewerA.token, org: orgA });
    status = d.json?.data?.document?.status || d.json?.data?.status;
    if (status === 'ready' || status === 'failed') break;
    await new Promise(r => setTimeout(r, 2000));
  }
  check('Document processed by worker (status=ready)', status === 'ready', `status ${status}`);
  const proc = await api('GET', `/api/documents/${docId}/processing`, { token: viewerA.token, org: orgA });
  check('Processing status visible to Viewer', proc.status === 200);
  check('Viewer cannot delete document', (await api('DELETE', `/api/documents/${docId}`, { token: viewerA.token, org: orgA })).status === 403);

  // ── Tenant isolation ───────────────────────────────────────────────────────
  check('Cross-tenant document access rejected (own org header)',
    [403, 404].includes((await api('GET', `/api/documents/${docId}`, { token: adminB.token, org: orgB })).status));
  check('Tenant spoofing rejected (X-Organization-Id of foreign org)',
    (await api('GET', `/api/documents/${docId}`, { token: adminB.token, org: orgA })).status === 403);
  const listB = await api('GET', '/api/documents', { token: adminB.token, org: orgB });
  check('Foreign org document list does not contain Org A document', listB.status === 200 && !listB.text.includes(docId));
  const ragB = await api('POST', '/api/rag/query', { token: adminB.token, org: orgB, body: { question: 'What is the production release codename for DocuMind?' } });
  check('Cross-tenant RAG retrieval returns no Org A content',
    ragB.status === 200 && !ragB.text.includes(FACT_CODE) && !ragB.text.includes(docId), `sources: ${(ragB.json?.data?.sources || []).length}`);

  // ── RAG ────────────────────────────────────────────────────────────────────
  const rag = await api('POST', '/api/rag/query', { token: viewerA.token, org: orgA, body: { question: 'What is the production release codename for DocuMind?' } });
  const ragCitations = rag.json?.data?.sources || rag.json?.data?.citations || [];
  check('RAG query (Viewer) answers with citation to uploaded document',
    rag.status === 200 && ragCitations.some(c => c.documentId === docId), `answer mentions code: ${rag.text.includes(FACT_CODE)}`);

  // ── Conversations + SSE through Nginx ──────────────────────────────────────
  const conv = await api('POST', '/api/conversations', { token: memberA.token, org: orgA, body: { title: `Smoke ${RUN}` } });
  const convId = conv.json?.data?.conversation?.id || conv.json?.data?.id;
  check('Create conversation', conv.status === 201 && convId);
  const s = await streamChat(memberA.token, orgA, convId, 'What is the production release codename for DocuMind? Answer in two sentences.');
  const names = s.events.map(e => e.ev);
  const firstToken = s.tokenTimes[0];
  const lastToken = s.tokenTimes[s.tokenTimes.length - 1];
  check('SSE stream through Nginx: 200 text/event-stream', s.status === 200 && /text\/event-stream/.test(s.contentType || ''));
  check('SSE lifecycle start → token+ → citation → done',
    names[0] === 'start' && names.includes('token') && names.includes('citation') && names[names.length - 1] === 'done', names.filter((n, i) => n !== names[i - 1]).join('→'));
  check('SSE tokens arrive progressively (not buffered until completion)',
    s.tokenTimes.length > 3 && s.chunks > 3 && lastToken - firstToken > 100,
    `${s.tokenTimes.length} tokens in ${s.chunks} network reads; first token @${Math.round(firstToken)}ms, last @${Math.round(lastToken)}ms, total ${Math.round(s.totalMs)}ms`);
  const doneEv = s.events.find(e => e.ev === 'done');
  const msgs = await api('GET', `/api/conversations/${convId}/messages`, { token: memberA.token, org: orgA });
  const list = msgs.json?.data?.messages || msgs.json?.data || [];
  const assistant = Array.isArray(list) ? list.find(m => m.id === doneEv?.data?.messageId) : null;
  check('Conversation reload: streamed answer persisted verbatim', assistant && assistant.content === s.text);
  const convGet = await api('GET', `/api/conversations/${convId}`, { token: memberA.token, org: orgA });
  check('Conversation reload: citations persisted', convGet.status === 200 && convGet.text.includes(docId));
  check('Cross-tenant conversation access rejected',
    [403, 404].includes((await api('GET', `/api/conversations/${convId}`, { token: adminB.token, org: orgB })).status));
  check('Cross-tenant SSE stream rejected before streaming',
    [403, 404].includes((await streamChat(adminB.token, orgB, convId, 'hello')).status));
  check('Unauthenticated SSE stream rejected',
    (await api('POST', `/api/conversations/${convId}/messages/stream`, { raw: true, body: { content: 'x' } })).status === 401);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('Smoke test crashed:', err); process.exit(1); });
