const supertest = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const { withTenantTransaction } = require('../../src/db/transaction');
const env = require('../../src/config/env');
const { getRedisClient } = require('../../src/middleware/rate-limiter');

describe('Step 4 — Complete Security, RLS & Multi-Tenant Test Suite', () => {
  let orgAId, orgBId;
  let aliceId, bobId, charlieId, davidId, eveId, viewerId;
  let aliceToken, bobToken, charlieToken, davidToken, eveToken, viewerToken;
  let docAId, docBId;

  const defaultPassword = 'Password123!';

  beforeAll(async () => {
    // 1. Clean tables
    await pool.query('TRUNCATE organizations, users, memberships, documents, document_processing_jobs, conversations, messages, citations, audit_logs CASCADE');

    const hashedPassword = await argon2.hash(defaultPassword);

    // 2. Create Organizations
    const resOrgA = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Organization A', 'org-a']
    );
    const resOrgB = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Organization B', 'org-b']
    );
    orgAId = resOrgA.rows[0].id;
    orgBId = resOrgB.rows[0].id;

    // 3. Create Users: Alice, Bob, Charlie, David, Eve (multi-org), Viewer
    const resAlice = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['alice@test.com', hashedPassword, 'Alice Admin']
    );
    const resBob = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['bob@test.com', hashedPassword, 'Bob Member']
    );
    const resCharlie = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['charlie@test.com', hashedPassword, 'Charlie Admin']
    );
    const resDavid = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['david@test.com', hashedPassword, 'David Member']
    );
    const resEve = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['eve@test.com', hashedPassword, 'Eve Multi']
    );
    const resViewer = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['viewer@test.com', hashedPassword, 'Frank Viewer']
    );

    aliceId = resAlice.rows[0].id;
    bobId = resBob.rows[0].id;
    charlieId = resCharlie.rows[0].id;
    davidId = resDavid.rows[0].id;
    eveId = resEve.rows[0].id;
    viewerId = resViewer.rows[0].id;

    // 4. Setup Memberships
    // Alice -> Org A ADMIN
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, aliceId, 'admin']);
    // Bob -> Org A MEMBER
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, bobId, 'member']);
    // Viewer -> Org A VIEWER
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, viewerId, 'viewer']);
    // Charlie -> Org B ADMIN
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgBId, charlieId, 'admin']);
    // David -> Org B MEMBER
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgBId, davidId, 'member']);
    // Eve -> Org A ADMIN, Org B MEMBER
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, eveId, 'admin']);
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgBId, eveId, 'member']);

    // 5. Setup Sample Documents for RLS Tests
    const resDocA = await pool.query(
      `INSERT INTO documents (organization_id, uploaded_by, filename, original_name, mime_type, file_size, storage_key, status)
       VALUES ($1, $2, 'docA.pdf', 'docA.pdf', 'application/pdf', 1024, 'org-a/docA.pdf', 'ready')
       RETURNING id`,
      [orgAId, aliceId]
    );
    const resDocB = await pool.query(
      `INSERT INTO documents (organization_id, uploaded_by, filename, original_name, mime_type, file_size, storage_key, status)
       VALUES ($1, $2, 'docB.pdf', 'docB.pdf', 'application/pdf', 2048, 'org-b/docB.pdf', 'ready')
       RETURNING id`,
      [orgBId, charlieId]
    );
    docAId = resDocA.rows[0].id;
    docBId = resDocB.rows[0].id;

    // 6. Generate Tokens
    aliceToken = jwt.sign({ userId: aliceId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    bobToken = jwt.sign({ userId: bobId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    charlieToken = jwt.sign({ userId: charlieId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    davidToken = jwt.sign({ userId: davidId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    eveToken = jwt.sign({ userId: eveId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    viewerToken = jwt.sign({ userId: viewerId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });

    // 7. Flush Redis cache/ratelimit keys for clean test state
    const redisClient = getRedisClient();
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    await redisClient.flushAll();
  });

  afterAll(async () => {
    await pool.query('TRUNCATE organizations, users, memberships, documents, document_processing_jobs, conversations, messages, citations, audit_logs CASCADE');
    await pool.end();
    const redisClient = getRedisClient();
    if (redisClient && redisClient.isOpen) {
      await redisClient.quit();
    }
  });

  const requestWithAuth = (token, orgId) => {
    const agent = supertest.agent(app);
    let req = agent.set('Cookie', `accessToken=${token}`);
    if (orgId) {
      req = req.set('X-Organization-Id', orgId);
    }
    return req;
  };

  // =========================================================================
  // 1. Health & Server Foundation
  // =========================================================================
  describe('Backend Foundation & Health Endpoint', () => {
    test('GET /health returns HTTP 200 with healthy status', async () => {
      const res = await supertest(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.service).toBe('documind-api');
    });

    test('Unknown routes return HTTP 404', async () => {
      const res = await supertest(app).get('/api/unknown-endpoint');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('fail');
    });
  });

  // =========================================================================
  // 2. Authentication Tests (Section 16.A)
  // =========================================================================
  describe('A. Authentication', () => {
    test('Unauthenticated request to protected endpoint is blocked (401)', async () => {
      const res = await supertest(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    test('Valid registration creates user and returns 201 without password hash', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({
          email: 'newuser@test.com',
          password: 'SecurePassword123!',
          fullName: 'New Test User',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.user.email).toBe('newuser@test.com');
      expect(res.body.data.user.password_hash).toBeUndefined();
      expect(res.body.data.user.password).toBeUndefined();
    });

    test('Duplicate registration is rejected (400)', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({
          email: 'alice@test.com',
          password: 'Password123!',
          fullName: 'Alice Clone',
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('fail');
    });

    test('Valid login sets HttpOnly cookies and returns 200', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({
          email: 'alice@test.com',
          password: defaultPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.user.email).toBe('alice@test.com');
      expect(res.body.data.accessToken).toBeDefined();

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some(c => c.includes('accessToken') && c.includes('HttpOnly'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken') && c.includes('HttpOnly'))).toBe(true);
    });

    test('Invalid password login is rejected (401)', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({
          email: 'alice@test.com',
          password: 'WrongPassword!',
        });

      expect(res.status).toBe(401);
      expect(res.body.status).toBe('fail');
    });

    test('GET /api/auth/me returns authenticated user info and organizations', async () => {
      const res = await requestWithAuth(aliceToken).get('/api/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(aliceId);
      expect(res.body.data.user.email).toBe('alice@test.com');
      expect(res.body.data.organizations).toBeDefined();
      expect(res.body.data.organizations.some(o => o.organization_id === orgAId)).toBe(true);
    });

    test('POST /api/auth/logout clears auth cookies', async () => {
      const res = await supertest(app).post('/api/auth/logout');
      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some(c => c.includes('accessToken=;') || c.includes('accessToken=; Max-Age=0'))).toBe(true);
    });
  });

  // =========================================================================
  // 3. Tenant Isolation & Context (Section 16.B)
  // =========================================================================
  describe('B. Tenant Isolation & Request Context', () => {
    test('Alice accessing Organization A is ALLOWED (200)', async () => {
      const res = await requestWithAuth(aliceToken, orgAId).get('/api/test/tenant');
      expect(res.status).toBe(200);
      expect(res.body.data.tenantId).toBe(orgAId);
      expect(res.body.data.role).toBe('admin');
    });

    test('Alice accessing Organization B is BLOCKED (403) — no membership', async () => {
      const res = await requestWithAuth(aliceToken, orgBId).get('/api/test/tenant');
      expect(res.status).toBe(403);
    });

    test('Charlie accessing Organization B is ALLOWED (200)', async () => {
      const res = await requestWithAuth(charlieToken, orgBId).get('/api/test/tenant');
      expect(res.status).toBe(200);
      expect(res.body.data.tenantId).toBe(orgBId);
      expect(res.body.data.role).toBe('admin');
    });

    test('Charlie accessing Organization A is BLOCKED (403) — no membership', async () => {
      const res = await requestWithAuth(charlieToken, orgAId).get('/api/test/tenant');
      expect(res.status).toBe(403);
    });

    test('Request without organization header is rejected (400)', async () => {
      const res = await requestWithAuth(aliceToken).get('/api/test/tenant');
      expect(res.status).toBe(400);
    });
  });

  // =========================================================================
  // 4. PostgreSQL RLS CRUD Proofs (Section 16.C - 16.F)
  // =========================================================================
  describe('C - F. PostgreSQL Row-Level Security (RLS) Proofs', () => {
    test('C. Cross-tenant READ: Tenant A cannot see Tenant B data', async () => {
      const rows = await withTenantTransaction(orgAId, async (client) => {
        const res = await client.query('SELECT * FROM documents WHERE id = $1', [docBId]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);

      // Verify Tenant A sees its own doc
      const rowsA = await withTenantTransaction(orgAId, async (client) => {
        const res = await client.query('SELECT * FROM documents WHERE id = $1', [docAId]);
        return res.rows;
      });
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].id).toBe(docAId);
    });

    test('D. Cross-tenant INSERT: Tenant A cannot insert record for Tenant B (WITH CHECK blocked)', async () => {
      await expect(
        withTenantTransaction(orgAId, async (client) => {
          await client.query(
            `INSERT INTO documents (organization_id, uploaded_by, filename, original_name, mime_type, file_size, storage_key, status)
             VALUES ($1, $2, 'malicious.pdf', 'malicious.pdf', 'application/pdf', 500, 'path/m', 'ready')`,
            [orgBId, aliceId]
          );
        })
      ).rejects.toThrow();
    });

    test('E. Cross-tenant UPDATE: Tenant A cannot update Tenant B record (0 rows updated)', async () => {
      const updatedCount = await withTenantTransaction(orgAId, async (client) => {
        const res = await client.query(
          "UPDATE documents SET filename = 'hacked.pdf' WHERE id = $1",
          [docBId]
        );
        return res.rowCount;
      });
      expect(updatedCount).toBe(0);

      // Verify docB filename remained unchanged in DB
      const resCheck = await pool.query('SELECT filename FROM documents WHERE id = $1', [docBId]);
      expect(resCheck.rows[0].filename).toBe('docB.pdf');
    });

    test('F. Cross-tenant DELETE: Tenant A cannot delete Tenant B record (0 rows deleted)', async () => {
      const deletedCount = await withTenantTransaction(orgAId, async (client) => {
        const res = await client.query('DELETE FROM documents WHERE id = $1', [docBId]);
        return res.rowCount;
      });
      expect(deletedCount).toBe(0);

      // Verify docB is still present
      const resCheck = await pool.query('SELECT id FROM documents WHERE id = $1', [docBId]);
      expect(resCheck.rows).toHaveLength(1);
    });

    test('Direct query without tenant context sees 0 rows under RLS', async () => {
      // Connect and assume non-superuser application role without setting app.current_tenant
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE documind_app');
        await client.query("SELECT set_config('app.current_tenant', '', true)");
        const res = await client.query('SELECT * FROM documents');
        expect(res.rows).toHaveLength(0);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
  });

  // =========================================================================
  // 5. RBAC & Multi-Organization Roles (Section 16.G & 16.H)
  // =========================================================================
  describe('G & H. RBAC & Multi-Organization Roles', () => {
    test('G1. ADMIN in Org A (Alice) can view members of Org A', async () => {
      const res = await requestWithAuth(aliceToken, orgAId).get(`/api/organizations/${orgAId}/members`);
      expect(res.status).toBe(200);
      expect(res.body.data.members).toBeDefined();
      expect(res.body.data.members.length).toBeGreaterThanOrEqual(2);
    });

    test('G2. MEMBER in Org A (Bob) is BLOCKED from viewing members of Org A (403)', async () => {
      const res = await requestWithAuth(bobToken, orgAId).get(`/api/organizations/${orgAId}/members`);
      expect(res.status).toBe(403);
    });

    test('G3. VIEWER in Org A is BLOCKED from admin operations (403)', async () => {
      const res = await requestWithAuth(viewerToken, orgAId).get(`/api/organizations/${orgAId}/members`);
      expect(res.status).toBe(403);
    });

    test('H. Multi-Org User (Eve): ADMIN in Org A -> Allowed; MEMBER in Org B -> Blocked', async () => {
      // Eve in Org A (Admin role)
      const resA = await requestWithAuth(eveToken, orgAId).get(`/api/organizations/${orgAId}/members`);
      expect(resA.status).toBe(200);

      // Eve in Org B (Member role)
      const resB = await requestWithAuth(eveToken, orgBId).get(`/api/organizations/${orgBId}/members`);
      expect(resB.status).toBe(403);
    });

    test('G4. Only ADMIN can change roles: MEMBER and VIEWER calling the endpoint directly get 403', async () => {
      const bobTry = await requestWithAuth(bobToken, orgAId)
        .post(`/api/organizations/${orgAId}/members`).send({ email: 'bob@test.com', role: 'admin' });
      const viewerTry = await requestWithAuth(viewerToken, orgAId)
        .post(`/api/organizations/${orgAId}/members`).send({ email: 'bob@test.com', role: 'admin' });
      expect(bobTry.status).toBe(403);
      expect(viewerTry.status).toBe(403);
      const { rows } = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [orgAId, bobId]);
      expect(rows[0].role).toBe('member');
    });

    test('G5. ADMIN changes a member role; the change is visible in the member list', async () => {
      const res = await requestWithAuth(aliceToken, orgAId)
        .post(`/api/organizations/${orgAId}/members`).send({ email: 'viewer@test.com', role: 'member' });
      expect(res.status).toBe(201);
      const list = await requestWithAuth(aliceToken, orgAId).get(`/api/organizations/${orgAId}/members`);
      expect(list.body.data.members.find(m => m.id === viewerId).role).toBe('member');
      // restore
      await requestWithAuth(aliceToken, orgAId)
        .post(`/api/organizations/${orgAId}/members`).send({ email: 'viewer@test.com', role: 'viewer' });
    });

    test('G6. The last ADMIN cannot be demoted (409); with two admins, demotion is allowed', async () => {
      // Org B: Charlie is the only admin
      const lastAdmin = await requestWithAuth(charlieToken, orgBId)
        .post(`/api/organizations/${orgBId}/members`).send({ email: 'charlie@test.com', role: 'member' });
      expect(lastAdmin.status).toBe(409);
      const { rows } = await pool.query('SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2', [orgBId, charlieId]);
      expect(rows[0].role).toBe('admin');

      // Org A: Alice and Eve are admins — demoting Eve is fine, then restore
      const demote = await requestWithAuth(aliceToken, orgAId)
        .post(`/api/organizations/${orgAId}/members`).send({ email: 'eve@test.com', role: 'member' });
      expect(demote.status).toBe(201);
      const restore = await requestWithAuth(aliceToken, orgAId)
        .post(`/api/organizations/${orgAId}/members`).send({ email: 'eve@test.com', role: 'admin' });
      expect(restore.status).toBe(201);
    });
  });

  // =========================================================================
  // 6. Connection Pool Leakage Prevention (Section 16.I)
  // =========================================================================
  describe('I. Connection Pool Leakage Prevention', () => {
    test('Tenant context is strictly transaction-local and never leaks to subsequent queries', async () => {
      const client = await pool.connect();
      try {
        // Step 1: Set tenant context in transaction
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant', $1, true)", [orgAId]);

        const inTxRes = await client.query("SELECT current_setting('app.current_tenant', true) as tenant");
        expect(inTxRes.rows[0].tenant).toBe(orgAId);

        await client.query('COMMIT');

        // Step 2: After transaction ends, setting must be wiped
        const afterTxRes = await client.query("SELECT current_setting('app.current_tenant', true) as tenant");
        expect(afterTxRes.rows[0].tenant).toBe('');
      } finally {
        client.release();
      }

      // Step 3: Re-acquire connection from pool and verify clean state
      const client2 = await pool.connect();
      try {
        const cleanRes = await client2.query("SELECT current_setting('app.current_tenant', true) as tenant");
        expect(cleanRes.rows[0].tenant).toBe('');
      } finally {
        client2.release();
      }
    });

    test('Interleaved sequential requests between Tenant A and Tenant B maintain complete isolation', async () => {
      for (let i = 0; i < 5; i++) {
        const resA = await requestWithAuth(aliceToken, orgAId).get('/api/test/tenant');
        expect(resA.status).toBe(200);
        expect(resA.body.data.tenantId).toBe(orgAId);

        const resB = await requestWithAuth(charlieToken, orgBId).get('/api/test/tenant');
        expect(resB.status).toBe(200);
        expect(resB.body.data.tenantId).toBe(orgBId);
      }
    });
  });

  // =========================================================================
  // 7. Rate Limiting (Section 16.J)
  // =========================================================================
  describe('J. Redis Rate Limiting', () => {
    test('Repeated requests on auth endpoint trigger HTTP 429 Too Many Requests', async () => {
      const uniqueEmail = `ratelimit_${Date.now()}@test.com`;

      let blocked = false;
      // Send 25 rapid requests exceeding the 20 request window limit
      for (let i = 0; i < 25; i++) {
        const res = await supertest(app)
          .post('/api/auth/login')
          .send({ email: uniqueEmail, password: 'WrongPassword' });

        if (res.status === 429) {
          blocked = true;
          expect(res.body.message).toMatch(/too many requests/i);
          break;
        }
      }

      expect(blocked).toBe(true);
    });
  });
});

