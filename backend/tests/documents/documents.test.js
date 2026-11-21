const supertest = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const env = require('../../src/config/env');
const minioService = require('../../src/storage/minio.service');
const documentService = require('../../src/documents/document.service');
const docRepo = require('../../src/repositories/document.repository');

describe('Step 5 — MinIO + Document Upload + Metadata + Isolation Tests', () => {
  let orgAId, orgBId;
  let adminAId, memberAId, viewerAId, adminBId;
  let adminAToken, memberAToken, viewerAToken, adminBToken;

  const defaultPassword = 'Password123!';

  // Helper buffers for testing
  const validPdfBuffer = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'),
    Buffer.from(' - Dummy Valid PDF Content for DocuMind Test'),
  ]);

  // DOCX is a zip archive starting with PK\x03\x04
  const validDocxBuffer = Buffer.concat([
    Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
    Buffer.from(' - Dummy Valid DOCX Content for DocuMind Test'),
  ]);

  const requestWithAuth = (token, orgId) => {
    const req = supertest(app);
    return {
      get: (url) => req.get(url).set('Authorization', `Bearer ${token}`).set('X-Organization-Id', orgId),
      post: (url) => req.post(url).set('Authorization', `Bearer ${token}`).set('X-Organization-Id', orgId),
      patch: (url) => req.patch(url).set('Authorization', `Bearer ${token}`).set('X-Organization-Id', orgId),
      delete: (url) => req.delete(url).set('Authorization', `Bearer ${token}`).set('X-Organization-Id', orgId),
    };
  };

  beforeAll(async () => {
    // 1. Initialize MinIO bucket
    await minioService.ensureBucketExists();

    // 2. Clean database tables
    await pool.query('TRUNCATE organizations, users, memberships, documents, document_processing_jobs, conversations, messages, citations, audit_logs CASCADE');

    const hashedPassword = await argon2.hash(defaultPassword);

    // 3. Create Organizations
    const resOrgA = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['DocuMind Org A', 'documind-org-a']
    );
    const resOrgB = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['DocuMind Org B', 'documind-org-b']
    );
    orgAId = resOrgA.rows[0].id;
    orgBId = resOrgB.rows[0].id;

    // 4. Create Users
    const resAdminA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['admin_a@documind.test', hashedPassword, 'Admin A']
    );
    const resMemberA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['member_a@documind.test', hashedPassword, 'Member A']
    );
    const resViewerA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['viewer_a@documind.test', hashedPassword, 'Viewer A']
    );
    const resAdminB = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['admin_b@documind.test', hashedPassword, 'Admin B']
    );

    adminAId = resAdminA.rows[0].id;
    memberAId = resMemberA.rows[0].id;
    viewerAId = resViewerA.rows[0].id;
    adminBId = resAdminB.rows[0].id;

    // 5. Create Memberships
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, adminAId, 'admin']);
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, memberAId, 'member']);
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, viewerAId, 'viewer']);
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgBId, adminBId, 'admin']);

    // 6. Generate Tokens
    adminAToken = jwt.sign({ userId: adminAId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    memberAToken = jwt.sign({ userId: memberAId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    viewerAToken = jwt.sign({ userId: viewerAId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    adminBToken = jwt.sign({ userId: adminBId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  });

  // =========================================================================
  // 1. MinIO Infrastructure & Bucket Initialization
  // =========================================================================
  describe('1. MinIO Infrastructure & Bucket Configuration', () => {
    test('MinIO connection and bucket existence verification succeeds', async () => {
      const exists = await minioService.client.bucketExists(env.MINIO_BUCKET);
      expect(exists).toBe(true);
    });

    test('Bucket initialization is idempotent and does not throw on repeated calls', async () => {
      await expect(minioService.ensureBucketExists()).resolves.not.toThrow();
      await expect(minioService.ensureBucketExists()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // 2. Document Upload & File Validation
  // =========================================================================
  describe('2. Document Upload & Validation', () => {
    test('Upload valid PDF succeeds and returns document metadata', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'test-report.pdf');

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.document).toBeDefined();

      const doc = res.body.data.document;
      expect(doc.id).toBeDefined();
      expect(doc.organization_id).toBe(orgAId);
      expect(doc.uploaded_by).toBe(adminAId);
      expect(doc.filename).toBe('test-report.pdf');
      expect(doc.original_name).toBe('test-report.pdf');
      expect(doc.mime_type).toBe('application/pdf');
      expect(parseInt(doc.file_size, 10)).toBe(validPdfBuffer.length);
      expect(doc.status).toBe('uploaded');
      expect(doc.storage_key).toBe(`organizations/${orgAId}/documents/${doc.id}/original/test-report.pdf`);

      const expectedChecksum = crypto.createHash('sha256').update(validPdfBuffer).digest('hex');
      expect(doc.checksum).toBe(expectedChecksum);

      // Verify object exists in MinIO
      const minioExists = await minioService.objectExists(doc.storage_key);
      expect(minioExists).toBe(true);
    });

    test('Upload valid DOCX succeeds and returns document metadata', async () => {
      const res = await requestWithAuth(memberAToken, orgAId)
        .post('/api/documents')
        .attach('file', validDocxBuffer, 'specs.docx');

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      const doc = res.body.data.document;
      expect(doc.organization_id).toBe(orgAId);
      expect(doc.uploaded_by).toBe(memberAId);
      expect(doc.filename).toBe('specs.docx');
      expect(doc.storage_key).toContain(`organizations/${orgAId}/documents/${doc.id}/original/specs.docx`);

      const minioExists = await minioService.objectExists(doc.storage_key);
      expect(minioExists).toBe(true);
    });

    test('Upload fails when no file is attached (400)', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents');

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no file/i);
    });

    test('Upload rejects unsupported file extensions like .txt, .exe (400)', async () => {
      const textBuffer = Buffer.from('Plain text file content');
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', textBuffer, 'notes.txt');

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/unsupported file extension/i);
    });

    test('Upload rejects empty files (400)', async () => {
      const emptyBuffer = Buffer.alloc(0);
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', emptyBuffer, 'empty.pdf');

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/empty/i);
    });

    test('Upload rejects oversized files exceeding MAX_FILE_SIZE_MB (413)', async () => {
      // Create a dummy buffer larger than 10MB (e.g., 10.5 MB)
      const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024);
      // Put PDF header at beginning
      Buffer.from('%PDF-1.4').copy(oversizedBuffer);

      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', oversizedBuffer, 'oversized.pdf');

      expect(res.status).toBe(413);
      expect(res.body.message).toMatch(/exceeds maximum limit/i);
    });

    test('Upload sanitizes unsafe filenames with directory traversal patterns', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, '../../etc/passwd..malicious.pdf');

      expect(res.status).toBe(201);
      const doc = res.body.data.document;
      expect(doc.filename).not.toContain('../');
      expect(doc.filename).not.toContain('/');
      expect(doc.filename).not.toContain('\\');
      expect(doc.storage_key).toBe(`organizations/${orgAId}/documents/${doc.id}/original/${doc.filename}`);
    });
  });

  // =========================================================================
  // 3. Document Listing, Retrieval & Download
  // =========================================================================
  describe('3. Document Listing, Retrieval & Download', () => {
    let testDoc;

    beforeAll(async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'listing-test.pdf');
      testDoc = res.body.data.document;
    });

    test('List documents returns paginated list for tenant', async () => {
      const res = await requestWithAuth(viewerAToken, orgAId).get('/api/documents?page=1&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.documents).toBeDefined();
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.page).toBe(1);
      expect(res.body.data.pagination.limit).toBe(10);
      expect(res.body.data.documents.length).toBeGreaterThanOrEqual(1);

      const found = res.body.data.documents.find(d => d.id === testDoc.id);
      expect(found).toBeDefined();
      expect(found.organization_id).toBe(orgAId);
    });

    test('Get document metadata by ID returns document details', async () => {
      const res = await requestWithAuth(viewerAToken, orgAId).get(`/api/documents/${testDoc.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.document.id).toBe(testDoc.id);
      expect(res.body.data.document.filename).toBe('listing-test.pdf');
    });

    test('Download document streams file with exact content and correct headers', async () => {
      const res = await requestWithAuth(viewerAToken, orgAId).get(`/api/documents/${testDoc.id}/download`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('listing-test.pdf');

      // Verify content matches original buffer
      expect(res.body).toEqual(validPdfBuffer);

      // Verify downloaded content hash
      const downloadedChecksum = crypto.createHash('sha256').update(res.body).digest('hex');
      expect(downloadedChecksum).toBe(testDoc.checksum);
    });

    test('Patch document metadata renames filename safely', async () => {
      const res = await requestWithAuth(memberAToken, orgAId)
        .patch(`/api/documents/${testDoc.id}`)
        .send({ filename: 'renamed-document.pdf' });

      expect(res.status).toBe(200);
      expect(res.body.data.document.filename).toBe('renamed-document.pdf');
      expect(res.body.data.document.id).toBe(testDoc.id);
      expect(res.body.data.document.organization_id).toBe(orgAId);
    });
  });

  // =========================================================================
  // 4. Document Deletion & Soft Delete
  // =========================================================================
  describe('4. Document Deletion', () => {
    test('Authorized deletion removes MinIO object and soft-deletes database record', async () => {
      // 1. Upload a document to delete
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'to-be-deleted.pdf');
      const docToDelete = uploadRes.body.data.document;

      // Verify MinIO object exists
      expect(await minioService.objectExists(docToDelete.storage_key)).toBe(true);

      // 2. Delete document
      const deleteRes = await requestWithAuth(adminAToken, orgAId).delete(`/api/documents/${docToDelete.id}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.message).toMatch(/deleted successfully/i);

      // 3. MinIO object must be deleted
      const minioStillExists = await minioService.objectExists(docToDelete.storage_key);
      expect(minioStillExists).toBe(false);

      // 4. Document must NOT be returned in list
      const listRes = await requestWithAuth(adminAToken, orgAId).get('/api/documents');
      const foundInList = listRes.body.data.documents.find(d => d.id === docToDelete.id);
      expect(foundInList).toBeUndefined();

      // 5. Document GET must return 404
      const getRes = await requestWithAuth(adminAToken, orgAId).get(`/api/documents/${docToDelete.id}`);
      expect(getRes.status).toBe(404);
    });
  });

  // =========================================================================
  // 5. RBAC Enforcement
  // =========================================================================
  describe('5. RBAC Enforcement on Document Operations', () => {
    test('ADMIN in Org A can upload, list, download, and delete documents', async () => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'admin-doc.pdf');
      expect(uploadRes.status).toBe(201);
      const docId = uploadRes.body.data.document.id;

      const getRes = await requestWithAuth(adminAToken, orgAId).get(`/api/documents/${docId}`);
      expect(getRes.status).toBe(200);

      const downloadRes = await requestWithAuth(adminAToken, orgAId).get(`/api/documents/${docId}/download`);
      expect(downloadRes.status).toBe(200);

      const deleteRes = await requestWithAuth(adminAToken, orgAId).delete(`/api/documents/${docId}`);
      expect(deleteRes.status).toBe(200);
    });

    test('MEMBER in Org A can upload, list, download, and delete documents', async () => {
      const uploadRes = await requestWithAuth(memberAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'member-doc.pdf');
      expect(uploadRes.status).toBe(201);
      const docId = uploadRes.body.data.document.id;

      const getRes = await requestWithAuth(memberAToken, orgAId).get(`/api/documents/${docId}`);
      expect(getRes.status).toBe(200);

      const deleteRes = await requestWithAuth(memberAToken, orgAId).delete(`/api/documents/${docId}`);
      expect(deleteRes.status).toBe(200);
    });

    test('VIEWER in Org A is BLOCKED from uploading documents (403)', async () => {
      const uploadRes = await requestWithAuth(viewerAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'viewer-attempt.pdf');
      expect(uploadRes.status).toBe(403);
    });

    test('VIEWER in Org A is BLOCKED from deleting documents (403)', async () => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'viewer-delete-target.pdf');
      const docId = uploadRes.body.data.document.id;

      const deleteRes = await requestWithAuth(viewerAToken, orgAId).delete(`/api/documents/${docId}`);
      expect(deleteRes.status).toBe(403);
    });
  });

  // =========================================================================
  // 6. Cross-Tenant Isolation & Anti-Spoofing
  // =========================================================================
  describe('6. Cross-Tenant Isolation & Tenant Spoofing Protection', () => {
    let docA, docB;

    beforeAll(async () => {
      const resA = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'tenant-a-confidential.pdf');
      docA = resA.body.data.document;

      const resB = await requestWithAuth(adminBToken, orgBId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'tenant-b-confidential.pdf');
      docB = resB.body.data.document;
    });

    test('Tenant A cannot list Tenant B documents in document list', async () => {
      const res = await requestWithAuth(adminAToken, orgAId).get('/api/documents');
      expect(res.status).toBe(200);
      const ids = res.body.data.documents.map(d => d.id);
      expect(ids).toContain(docA.id);
      expect(ids).not.toContain(docB.id);
    });

    test('Tenant A cannot get Tenant B document metadata (404 / no leak)', async () => {
      const res = await requestWithAuth(adminAToken, orgAId).get(`/api/documents/${docB.id}`);
      expect(res.status).toBe(404);
      expect(res.body.data).toBeUndefined();
    });

    test('Tenant A cannot download Tenant B document file (404)', async () => {
      const res = await requestWithAuth(adminAToken, orgAId).get(`/api/documents/${docB.id}/download`);
      expect(res.status).toBe(404);
    });

    test('Tenant A cannot delete Tenant B document (404)', async () => {
      const res = await requestWithAuth(adminAToken, orgAId).delete(`/api/documents/${docB.id}`);
      expect(res.status).toBe(404);

      // Verify B document still exists in MinIO and DB for Tenant B
      const resB = await requestWithAuth(adminBToken, orgBId).get(`/api/documents/${docB.id}`);
      expect(resB.status).toBe(200);
    });

    test('Tenant A cannot update/patch Tenant B document metadata (404)', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .patch(`/api/documents/${docB.id}`)
        .send({ filename: 'hacked.pdf' });
      expect(res.status).toBe(404);
    });

    test('Tenant spoofing: Sending X-Organization-Id for Org B while user is only in Org A is BLOCKED (403)', async () => {
      const res = await supertest(app)
        .get('/api/documents')
        .set('Authorization', `Bearer ${adminAToken}`)
        .set('X-Organization-Id', orgBId);

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/do not belong to this organization/i);
    });

    test('Tenant spoofing: Sending organization_id in upload body is ignored, file is assigned to authenticated tenant', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .field('organization_id', orgBId)
        .field('organizationId', orgBId)
        .attach('file', validPdfBuffer, 'spoof-test.pdf');

      expect(res.status).toBe(201);
      const doc = res.body.data.document;
      expect(doc.organization_id).toBe(orgAId);
      expect(doc.organization_id).not.toBe(orgBId);
      expect(doc.storage_key).toContain(`organizations/${orgAId}/`);
      expect(doc.storage_key).not.toContain(`organizations/${orgBId}/`);
    });
  });

  // =========================================================================
  // 7. Consistency & Failure Recovery
  // =========================================================================
  describe('7. Storage & Database Consistency', () => {
    test('MinIO upload failure prevents database metadata creation', async () => {
      // Spy on MinIO putObject to simulate an upload failure
      const minioSpy = jest.spyOn(minioService.client, 'putObject').mockRejectedValueOnce(new Error('MinIO connection timeout'));

      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'fail-upload.pdf');

      expect(res.status).toBe(500);

      // Verify no document was created in DB
      const listRes = await requestWithAuth(adminAToken, orgAId).get('/api/documents');
      const found = listRes.body.data.documents.find(d => d.filename === 'fail-upload.pdf');
      expect(found).toBeUndefined();

      minioSpy.mockRestore();
    });

    test('Database insertion failure triggers cleanup of the uploaded MinIO object', async () => {
      // Spy on docRepo.createDocument to simulate database constraint or crash after upload
      const repoSpy = jest.spyOn(docRepo, 'createDocument').mockRejectedValueOnce(new Error('Simulated Database Crash'));
      const deleteObjectSpy = jest.spyOn(minioService, 'deleteObject');

      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', validPdfBuffer, 'cleanup-test.pdf');

      expect(res.status).toBe(500);
      // Verify deleteObject cleanup was called to prevent orphan objects
      expect(deleteObjectSpy).toHaveBeenCalled();

      repoSpy.mockRestore();
      deleteObjectSpy.mockRestore();
    });
  });
});
