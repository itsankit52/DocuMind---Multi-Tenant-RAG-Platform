const supertest = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../../src/app');
const { pool } = require('../../src/db');
const { withTenantTransaction } = require('../../src/db/transaction');
const env = require('../../src/config/env');
const minioService = require('../../src/storage/minio.service');
const rabbitmqService = require('../../src/queue/rabbitmq.service');
const qdrantService = require('../../src/vector/qdrant.service');
const embeddingService = require('../../src/embeddings/embedding.service');
const DocumentProcessor = require('../../src/workers/processor');
const documentService = require('../../src/documents/document.service');
const jobRepo = require('../../src/repositories/job.repository');
const chunkRepo = require('../../src/repositories/chunk.repository');
const { createTestPdf, createEmptyPdf } = require('../fixtures/document.fixtures');

describe('Step 7 — Embeddings & Qdrant Vector Store Integration Tests', () => {
  let orgAId, orgBId;
  let adminAId, adminBId;
  let adminAToken, adminBToken;
  let processor;
  let samplePdf;
  let emptyPdf;

  const defaultPassword = 'Password123!';

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
    samplePdf = await createTestPdf([
      'DocuMind Multi-Tenant RAG Vector Database Section',
      'Qdrant Vector Indexing and Semantic Similarity Architecture',
    ]);
    emptyPdf = await createEmptyPdf();

    await minioService.ensureBucketExists();
    await rabbitmqService.connect();
    await qdrantService.ensureCollection(env.QDRANT_COLLECTION, env.EMBEDDING_DIMENSION);

    processor = new DocumentProcessor('test-step7-worker');

    // Clean DB
    await pool.query('TRUNCATE organizations, users, memberships, documents, document_processing_jobs, document_chunks, outbox_events, conversations, messages, citations, audit_logs CASCADE');

    const hashedPassword = await argon2.hash(defaultPassword);

    // Create Organizations
    const resOrgA = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Vector Org Alpha', 'vec-org-a']
    );
    const resOrgB = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['Vector Org Beta', 'vec-org-b']
    );
    orgAId = resOrgA.rows[0].id;
    orgBId = resOrgB.rows[0].id;

    // Create Users
    const resAdminA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['vec_admin_a@documind.test', hashedPassword, 'Vector Admin A']
    );
    const resAdminB = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['vec_admin_b@documind.test', hashedPassword, 'Vector Admin B']
    );
    adminAId = resAdminA.rows[0].id;
    adminBId = resAdminB.rows[0].id;

    // Memberships
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgAId, adminAId, 'admin']);
    await pool.query('INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)', [orgBId, adminBId, 'admin']);

    // Tokens
    adminAToken = jwt.sign({ userId: adminAId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    adminBToken = jwt.sign({ userId: adminBId }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await rabbitmqService.close();
  });

  // =========================================================================
  // 1. Ollama Embedding Service Unit Tests
  // =========================================================================
  describe('1. Ollama Embedding Service Unit Tests', () => {
    test('embedText generates valid 768-dimensional embedding for valid text', async () => {
      const embedding = await embeddingService.embedText('DocuMind vector semantic retrieval test');
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBe(768);
      for (const val of embedding) {
        expect(typeof val).toBe('number');
        expect(isNaN(val)).toBe(false);
      }
    });

    test('embedText rejects invalid / empty input strings', async () => {
      await expect(embeddingService.embedText('')).rejects.toThrow(/cannot be empty/i);
      await expect(embeddingService.embedText('   \n\t ')).rejects.toThrow(/cannot be empty/i);
      await expect(embeddingService.embedText(null)).rejects.toThrow(/must not be null/i);
      await expect(embeddingService.embedText(12345)).rejects.toThrow(/must be a string/i);
    });

    test('embedText rejects oversized input text', async () => {
      const hugeText = 'A'.repeat(60000);
      await expect(embeddingService.embedText(hugeText)).rejects.toThrow(/exceeds maximum allowed size/i);
    });

    test('validateEmbedding catches malformed Ollama responses and wrong dimensions', () => {
      expect(() => embeddingService.validateEmbedding(null)).toThrow(/expected array/i);
      expect(() => embeddingService.validateEmbedding([])).toThrow(/empty embedding/i);
      expect(() => embeddingService.validateEmbedding([1, 2, 3])).toThrow(/dimension mismatch/i);
      expect(() => embeddingService.validateEmbedding(new Array(768).fill('invalid'))).toThrow(/non-numeric/i);
    });

    test('embedTexts handles batching and preserves chunk index order', async () => {
      const texts = [
        'First chunk text regarding PostgreSQL RLS',
        'Second chunk text regarding Qdrant vector storage',
        'Third chunk text regarding Ollama nomic-embed-text',
      ];
      const embeddings = await embeddingService.embedTexts(texts, { concurrency: 2 });
      expect(embeddings.length).toBe(3);
      expect(embeddings[0].length).toBe(768);
      expect(embeddings[1].length).toBe(768);
      expect(embeddings[2].length).toBe(768);
    });

    test('healthCheck returns healthy status when Ollama is running', async () => {
      const health = await embeddingService.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.modelLoaded).toBe(true);
    });
  });

  // =========================================================================
  // 2. Qdrant Vector Store Service Unit Tests
  // =========================================================================
  describe('2. Qdrant Vector Store Service Unit Tests', () => {
    const testCollection = 'test_qdrant_unit_collection';

    beforeAll(async () => {
      await qdrantService.ensureCollection(testCollection, 768);
    });

    test('healthCheck reports healthy status', async () => {
      const health = await qdrantService.healthCheck();
      expect(health.status).toBe('healthy');
    });

    test('ensureCollection creates collection with correct vector dimensions & cosine metric', async () => {
      const exists = await qdrantService.collectionExists(testCollection);
      expect(exists).toBe(true);

      const info = await qdrantService.getCollectionInfo(testCollection);
      expect(info.config.params.vectors.size).toBe(768);
      expect(info.config.params.vectors.distance).toBe('Cosine');
    });

    test('upsertPoints rejects points missing mandatory tenant payload', async () => {
      const invalidPoint = {
        id: crypto.randomUUID(),
        vector: new Array(768).fill(0.1),
        payload: { document_id: crypto.randomUUID() }, // Missing organization_id
      };
      await expect(qdrantService.upsertPoints(testCollection, [invalidPoint])).rejects.toThrow(
        /missing mandatory organization_id/i
      );
    });

    test('upsertPoints stores points and getPoint retrieves exact vector and payload', async () => {
      const pointId = crypto.randomUUID();
      const testVector = new Array(768).fill(0.05);
      const payload = {
        organization_id: orgAId,
        document_id: crypto.randomUUID(),
        chunk_id: pointId,
        chunk_index: 0,
        content_hash: 'abc123hash',
      };

      const res = await qdrantService.upsertPoints(testCollection, [
        { id: pointId, vector: testVector, payload },
      ]);
      expect(res.status).toBe('ok');

      const retrieved = await qdrantService.getPoint(testCollection, pointId);
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(pointId);
      expect(retrieved.payload.organization_id).toBe(orgAId);
      expect(retrieved.payload.chunk_id).toBe(pointId);
      expect(retrieved.payload.content_hash).toBe('abc123hash');
    });

    test('searchPoints strictly enforces tenant isolation and matches only tenant vectors', async () => {
      const pointOrgA = crypto.randomUUID();
      const pointOrgB = crypto.randomUUID();
      const vector = new Array(768).fill(0.2);

      await qdrantService.upsertPoints(testCollection, [
        {
          id: pointOrgA,
          vector,
          payload: { organization_id: orgAId, document_id: crypto.randomUUID(), chunk_id: pointOrgA },
        },
        {
          id: pointOrgB,
          vector,
          payload: { organization_id: orgBId, document_id: crypto.randomUUID(), chunk_id: pointOrgB },
        },
      ]);

      // Search scoped to Org A
      const resultsOrgA = await qdrantService.searchPoints(testCollection, {
        vector,
        organizationId: orgAId,
        limit: 10,
      });

      expect(resultsOrgA.length).toBeGreaterThanOrEqual(1);
      for (const match of resultsOrgA) {
        expect(match.payload.organization_id).toBe(orgAId);
        expect(match.payload.organization_id).not.toBe(orgBId);
      }

      // Search scoped to Org B
      const resultsOrgB = await qdrantService.searchPoints(testCollection, {
        vector,
        organizationId: orgBId,
        limit: 10,
      });

      expect(resultsOrgB.length).toBeGreaterThanOrEqual(1);
      for (const match of resultsOrgB) {
        expect(match.payload.organization_id).toBe(orgBId);
        expect(match.payload.organization_id).not.toBe(orgAId);
      }
    });

    test('searchPoints throws error if organizationId is omitted (anti-tamper check)', async () => {
      await expect(
        qdrantService.searchPoints(testCollection, {
          vector: new Array(768).fill(0.1),
          organizationId: null,
        })
      ).rejects.toThrow(/Tenant isolation violation/i);
    });

    test('deleteByDocument removes all vectors for the specified document and tenant', async () => {
      const docId = crypto.randomUUID();
      const point1 = crypto.randomUUID();
      const point2 = crypto.randomUUID();

      await qdrantService.upsertPoints(testCollection, [
        { id: point1, vector: new Array(768).fill(0.3), payload: { organization_id: orgAId, document_id: docId, chunk_id: point1 } },
        { id: point2, vector: new Array(768).fill(0.3), payload: { organization_id: orgAId, document_id: docId, chunk_id: point2 } },
      ]);

      await qdrantService.deleteByDocument({
        organizationId: orgAId,
        documentId: docId,
        collectionName: testCollection,
      });

      const p1 = await qdrantService.getPoint(testCollection, point1);
      const p2 = await qdrantService.getPoint(testCollection, point2);
      expect(p1).toBeNull();
      expect(p2).toBeNull();
    });
  });

  // =========================================================================
  // 3. End-to-End Worker Document Embedding & Indexing Pipeline
  // =========================================================================
  describe('3. End-to-End Worker Pipeline: Chunks -> Ollama -> Qdrant', () => {
    let uploadedDoc;

    beforeAll(async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'e2e-vector-doc.pdf');

      expect(res.status).toBe(201);
      uploadedDoc = res.body.data.document;
    });

    test('Worker processes job: extracts text, creates chunks, generates embeddings, and indexes into Qdrant', async () => {
      let ackCalled = false;
      const controls = {
        ack: () => { ackCalled = true; },
        nack: () => {},
        retry: () => {},
      };

      const payload = {
        event: 'document.process',
        jobId: uploadedDoc.job.id,
        documentId: uploadedDoc.id,
        organizationId: orgAId,
        version: 1,
      };

      await processor.processJob(payload, controls);
      expect(ackCalled).toBe(true);

      // Verify PostgreSQL Job & Document Status
      const jobRes = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [uploadedDoc.job.id]);
      expect(jobRes.rows[0].status).toBe('completed');
      expect(jobRes.rows[0].stage).toBe('completed');
      expect(jobRes.rows[0].finished_at).not.toBeNull();

      const docRes = await pool.query('SELECT * FROM documents WHERE id = $1', [uploadedDoc.id]);
      expect(docRes.rows[0].status).toBe('ready');

      // Verify Chunks in PostgreSQL
      const chunksRes = await pool.query(
        'SELECT * FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC',
        [uploadedDoc.id]
      );
      expect(chunksRes.rows.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunksRes.rows) {
        expect(chunk.embedded_at).not.toBeNull();
        expect(chunk.organization_id).toBe(orgAId);
      }

      // Verify Vector Integrity in Qdrant directly
      for (const chunk of chunksRes.rows) {
        const point = await qdrantService.getPoint(env.QDRANT_COLLECTION, chunk.id);
        expect(point).not.toBeNull();
        expect(point.id).toBe(chunk.id);
        expect(point.payload.organization_id).toBe(orgAId);
        expect(point.payload.document_id).toBe(uploadedDoc.id);
        expect(point.payload.chunk_id).toBe(chunk.id);
        expect(point.payload.chunk_index).toBe(chunk.chunk_index);
        expect(point.payload.content_hash).toBe(crypto.createHash('sha256').update(chunk.content).digest('hex'));
      }
    });

    test('Duplicate job delivery is idempotent and does not create duplicate vector points in Qdrant', async () => {
      let ackCalled = false;
      const controls = {
        ack: () => { ackCalled = true; },
        nack: () => {},
        retry: () => {},
      };

      const payload = {
        event: 'document.process',
        jobId: uploadedDoc.job.id,
        documentId: uploadedDoc.id,
        organizationId: orgAId,
        version: 1,
      };

      // Second duplicate delivery
      await processor.processJob(payload, controls);
      expect(ackCalled).toBe(true);

      const chunksRes = await pool.query(
        'SELECT * FROM document_chunks WHERE document_id = $1',
        [uploadedDoc.id]
      );

      // Verify all points still exist exactly once with deterministic IDs
      for (const chunk of chunksRes.rows) {
        const point = await qdrantService.getPoint(env.QDRANT_COLLECTION, chunk.id);
        expect(point).not.toBeNull();
        expect(point.id).toBe(chunk.id);
      }
    });
  });

  // =========================================================================
  // 4. Strict Cross-Tenant Isolation & Anti-Leakage
  // =========================================================================
  describe('4. Strict Cross-Tenant Vector Isolation', () => {
    let docA, docB;

    beforeAll(async () => {
      const resA = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'tenant-a-rag-doc.pdf');
      docA = resA.body.data.document;

      const resB = await requestWithAuth(adminBToken, orgBId)
        .post('/api/documents')
        .attach('file', samplePdf, 'tenant-b-rag-doc.pdf');
      docB = resB.body.data.document;

      await processor.processJob(
        { event: 'document.process', jobId: docA.job.id, documentId: docA.id, organizationId: orgAId },
        { ack: () => {}, nack: () => {}, retry: () => {} }
      );
      await processor.processJob(
        { event: 'document.process', jobId: docB.job.id, documentId: docB.id, organizationId: orgBId },
        { ack: () => {}, nack: () => {}, retry: () => {} }
      );
    });

    test('Qdrant search with Tenant A filter NEVER returns Tenant B vectors', async () => {
      const queryEmbedding = await embeddingService.embedText('DocuMind Vector Database');

      // Tenant A search
      const resultsA = await qdrantService.searchPoints(env.QDRANT_COLLECTION, {
        vector: queryEmbedding,
        organizationId: orgAId,
        limit: 20,
      });

      expect(resultsA.length).toBeGreaterThan(0);
      for (const hit of resultsA) {
        expect(hit.payload.organization_id).toBe(orgAId);
        expect(hit.payload.organization_id).not.toBe(orgBId);
        expect(hit.payload.document_id).not.toBe(docB.id);
      }

      // Tenant B search
      const resultsB = await qdrantService.searchPoints(env.QDRANT_COLLECTION, {
        vector: queryEmbedding,
        organizationId: orgBId,
        limit: 20,
      });

      expect(resultsB.length).toBeGreaterThan(0);
      for (const hit of resultsB) {
        expect(hit.payload.organization_id).toBe(orgBId);
        expect(hit.payload.organization_id).not.toBe(orgAId);
        expect(hit.payload.document_id).not.toBe(docA.id);
      }
    });

    test('Deleting document removes all associated vectors from Qdrant and preserves other tenant vectors', async () => {
      const chunksA = await pool.query('SELECT id FROM document_chunks WHERE document_id = $1', [docA.id]);
      const chunksB = await pool.query('SELECT id FROM document_chunks WHERE document_id = $1', [docB.id]);
      expect(chunksA.rows.length).toBeGreaterThan(0);
      expect(chunksB.rows.length).toBeGreaterThan(0);

      // Delete Document A via documentService
      await documentService.deleteDocument({
        orgId: orgAId,
        documentId: docA.id,
        userId: adminAId,
      });

      // Verify Doc A vectors are removed from Qdrant
      for (const row of chunksA.rows) {
        const point = await qdrantService.getPoint(env.QDRANT_COLLECTION, row.id);
        expect(point).toBeNull();
      }

      // Verify Doc B vectors remain intact
      for (const row of chunksB.rows) {
        const point = await qdrantService.getPoint(env.QDRANT_COLLECTION, row.id);
        expect(point).not.toBeNull();
        expect(point.payload.organization_id).toBe(orgBId);
      }
    });
  });

  // =========================================================================
  // 5. Error Handling, Retries & Partial Failures
  // =========================================================================
  describe('5. Error Handling & Retry Behavior', () => {
    test('Transient embedding failure triggers retry with exponential backoff', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'retry-embed-doc.pdf');
      const doc = res.body.data.document;

      // Mock transient Ollama failure
      const embedSpy = jest.spyOn(embeddingService, 'embedTexts').mockRejectedValueOnce(
        new Error('Ollama temporary network timeout')
      );

      let retryDelay = null;
      const controls = {
        ack: () => {},
        nack: () => {},
        retry: (delay) => { retryDelay = delay; },
      };

      await processor.processJob(
        { event: 'document.process', jobId: doc.job.id, documentId: doc.id, organizationId: orgAId },
        controls
      );

      expect(retryDelay).toBe(2000); // 1st attempt backoff
      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows[0].status).toBe('retrying');

      embedSpy.mockRestore();
    });

    test('Transient Qdrant upsert failure triggers retry with exponential backoff', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'retry-qdrant-doc.pdf');
      const doc = res.body.data.document;

      // Mock transient Qdrant failure
      const qdrantSpy = jest.spyOn(qdrantService, 'upsertPoints').mockRejectedValueOnce(
        new Error('Qdrant connection refused')
      );

      let retryDelay = null;
      const controls = {
        ack: () => {},
        nack: () => {},
        retry: (delay) => { retryDelay = delay; },
      };

      await processor.processJob(
        { event: 'document.process', jobId: doc.job.id, documentId: doc.id, organizationId: orgAId },
        controls
      );

      expect(retryDelay).toBe(2000);
      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows[0].status).toBe('retrying');

      qdrantSpy.mockRestore();
    });

    test('Permanent failure routes to DLQ and marks job & document FAILED with audit log', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', emptyPdf, 'fail-vector-doc.pdf');
      const doc = res.body.data.document;

      const dlqSpy = jest.spyOn(rabbitmqService, 'publishDeadLetter');
      let acked = false;

      await processor.processJob(
        { event: 'document.process', jobId: doc.job.id, documentId: doc.id, organizationId: orgAId },
        { ack: () => { acked = true; }, nack: () => {}, retry: () => {} }
      );

      expect(acked).toBe(true);
      expect(dlqSpy).toHaveBeenCalled();

      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows[0].status).toBe('failed');

      const docRow = await pool.query('SELECT * FROM documents WHERE id = $1', [doc.id]);
      expect(docRow.rows[0].status).toBe('failed');

      const auditRow = await pool.query(
        "SELECT * FROM audit_logs WHERE resource_id = $1 AND action = 'DOCUMENT_PROCESSING_FAILED'",
        [doc.id]
      );
      expect(auditRow.rows.length).toBe(1);
      expect(auditRow.rows[0].actor_id).toBeNull();

      dlqSpy.mockRestore();
    });
  });
});
