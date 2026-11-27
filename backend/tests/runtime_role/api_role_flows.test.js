/**
 * End-to-end API flows under documind_api privileges — no password needed.
 *
 * Production runs the API as documind_api (NOBYPASSRLS, no direct privilege on tenant tables;
 * tenant access only via SET LOCAL ROLE documind_app). This suite loads an isolated app whose
 * pool connections run `SET ROLE documind_api` first, so every request executes with exactly
 * that role's privileges, and drives the flows the login-based suite (api_role.test.js) does not:
 * document upload / list / get / download / rename / reprocess / delete, conversations, member
 * removal and role changes. It also checks that organization B stays invisible throughout.
 * Runs on documind_test only (the test guard enforces it).
 */

const supertest = require('supertest');
const h = require('../streaming/stream.helpers');
const { createTestPdf } = require('../fixtures/document.fixtures');

const adminPool = require('../../src/db').pool;

let api; // isolated app graph whose connections are documind_api
let orgA;
let orgB;
let docB;
let pdf;

const as = (token, orgId) => {
  const r = supertest(api.app);
  const auth = (req) => {
    req.set('Authorization', `Bearer ${token}`);
    return orgId ? req.set('X-Organization-Id', orgId) : req;
  };
  return {
    get: (u) => auth(r.get(u)),
    post: (u) => auth(r.post(u)),
    patch: (u) => auth(r.patch(u)),
    del: (u) => auth(r.delete(u)),
  };
};

beforeAll(async () => {
  expect((await adminPool.query('SELECT current_database() AS d')).rows[0].d).toBe('documind_test');
  jest.isolateModules(() => {
    api = {
      app: require('../../src/app'),
      pool: require('../../src/db').pool,
      redis: require('../../src/middleware/rate-limiter').getRedisClient(),
    };
  });
  // Queued before any other query on each new connection (pg runs a client's queries in order)
  api.pool.on('connect', (client) => { client.query('SET ROLE documind_api').catch(() => {}); });
  const { rows: [who] } = await api.pool.query(
    'SELECT current_user AS cu, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass');
  expect(who).toEqual({ cu: 'documind_api', bypass: false });

  await h.truncateAll();
  const keys = [...await api.redis.keys('ratelimit:*')];
  if (keys.length) await api.redis.del(keys);
  orgA = await h.createOrgWithUsers('apiflow-a', ['admin', 'member', 'viewer']);
  orgB = await h.createOrgWithUsers('apiflow-b', ['admin']);
  pdf = await createTestPdf(['DocuMind role flow test']);
  const up = await as(orgB.users.admin.token, orgB.orgId).post('/api/documents').attach('file', pdf, 'b-secret.pdf');
  expect(up.status).toBe(201);
  docB = up.body.data.document;
});

afterAll(async () => {
  await h.truncateAll();
  if (api) { await api.pool.end(); if (api.redis.isOpen) await api.redis.quit(); }
  await adminPool.end();
});

test('a direct (non-tenant) query as documind_api cannot read tenant tables', async () => {
  await expect(api.pool.query('SELECT count(*) FROM documents')).rejects.toMatchObject({ code: '42501' });
});

test('documents: upload, list, get, download, rename, reprocess and delete work; B stays invisible', async () => {
  const member = as(orgA.users.member.token, orgA.orgId);
  const up = await member.post('/api/documents').attach('file', pdf, 'a-report.pdf');
  expect(up.status).toBe(201);
  const doc = up.body.data.document;
  expect(doc.storage_key).toContain(`organizations/${orgA.orgId}/`);

  const list = await member.get('/api/documents');
  expect(list.status).toBe(200);
  const ids = JSON.stringify(list.body);
  expect(ids).toContain(doc.id);
  expect(ids).not.toContain(docB.id);

  expect((await member.get(`/api/documents/${doc.id}`)).status).toBe(200);
  const dl = await as(orgA.users.viewer.token, orgA.orgId).get(`/api/documents/${doc.id}/download`);
  expect(dl.status).toBe(200);
  expect((await member.patch(`/api/documents/${doc.id}`).send({ filename: 'renamed.pdf' })).status).toBe(200);
  expect((await member.post(`/api/documents/${doc.id}/reprocess`)).status).toBeLessThan(500);

  // Organization B's document: not found from A, also by direct ID
  expect((await member.get(`/api/documents/${docB.id}`)).status).toBe(404);
  expect((await member.get(`/api/documents/${docB.id}/download`)).status).toBe(404);
  expect((await member.del(`/api/documents/${docB.id}`)).status).toBe(404);

  expect((await member.del(`/api/documents/${doc.id}`)).status).toBe(200);
  const { rows } = await adminPool.query(
    "SELECT action FROM audit_logs WHERE organization_id = $1 AND resource_id = $2 ORDER BY created_at", [orgA.orgId, doc.id]);
  expect(rows.map(r => r.action)).toEqual(expect.arrayContaining(['DOCUMENT_UPLOAD', 'DOCUMENT_UPDATE_METADATA', 'DOCUMENT_DELETE']));
  expect((await adminPool.query('SELECT 1 FROM documents WHERE id = $1', [docB.id])).rowCount).toBe(1);
});

test('conversations: create, list and delete work; nothing leaks across organizations', async () => {
  const viewer = as(orgA.users.viewer.token, orgA.orgId);
  const created = await viewer.post('/api/conversations').send({ title: 'Role flow chat' });
  expect(created.status).toBe(201);
  const convId = created.body.data.conversation.id;
  const listed = await viewer.get('/api/conversations');
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).toContain(convId);
  expect((await as(orgB.users.admin.token, orgB.orgId).get(`/api/conversations/${convId}`)).status).toBe(404);
  const member = as(orgA.users.member.token, orgA.orgId);
  const mine = await member.post('/api/conversations').send({ title: 'Member chat' });
  expect((await member.del(`/api/conversations/${mine.body.data.conversation.id}`)).status).toBe(200);
});

test('members: role change and removal work, with their audit entries in the right organization', async () => {
  const admin = as(orgA.users.admin.token);
  const change = await admin.post(`/api/organizations/${orgA.orgId}/members`)
    .send({ email: 'apiflow-a_viewer@documind.test', role: 'member' });
  expect(change.status).toBe(201);
  const removed = await admin.del(`/api/organizations/${orgA.orgId}/members/${orgA.users.viewer.id}`);
  expect(removed.status).toBe(200);
  expect((await as(orgA.users.viewer.token, orgA.orgId).get('/api/documents')).status).toBe(403);
  // last admin protection still holds under this role
  expect((await admin.del(`/api/organizations/${orgA.orgId}/members/${orgA.users.admin.id}`)).status).toBe(409);
  const { rows } = await adminPool.query(
    "SELECT organization_id, action FROM audit_logs WHERE resource_id = $1 AND action LIKE 'MEMBER_%' ORDER BY created_at",
    [orgA.users.viewer.id]);
  expect(rows).toEqual([
    { organization_id: orgA.orgId, action: 'MEMBER_ROLE_CHANGE' },
    { organization_id: orgA.orgId, action: 'MEMBER_REMOVE' },
  ]);
});
