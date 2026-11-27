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
const DocumentProcessor = require('../../src/workers/processor');
const { extractPdfText } = require('../../src/processing/extractors/pdf.extractor');
const { extractDocxText } = require('../../src/processing/extractors/docx.extractor');
const { normalizeText, normalizePages } = require('../../src/processing/normalizer');
const { createChunks } = require('../../src/processing/chunker');
const jobRepo = require('../../src/repositories/job.repository');
const chunkRepo = require('../../src/repositories/chunk.repository');
const { createTestPdf, createEmptyPdf } = require('../fixtures/document.fixtures');

describe('Step 6 — Document Processing Pipeline & Worker Tests', () => {
  let orgAId, orgBId;
  let adminAId, memberAId, viewerAId, adminBId;
  let adminAToken, memberAToken, viewerAToken, adminBToken;
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
    // 1. Generate fixtures
    samplePdf = await createTestPdf([
      'Page 1: DocuMind Architecture Overview and Multi-Tenant Security Details',
      'Page 2: Worker Processing Pipeline and Chunking Specifications',
    ]);
    emptyPdf = await createEmptyPdf();

    // 2. Ensure MinIO bucket and RabbitMQ topology
    await minioService.ensureBucketExists();
    await rabbitmqService.connect();

    processor = new DocumentProcessor('test-worker-1');

    // 2. Clean database tables
    await pool.query('TRUNCATE organizations, users, memberships, documents, document_processing_jobs, document_chunks, outbox_events, conversations, messages, citations, audit_logs CASCADE');

    const hashedPassword = await argon2.hash(defaultPassword);

    // 3. Create Organizations
    const resOrgA = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['DocuMind Processing Org A', 'documind-proc-a']
    );
    const resOrgB = await pool.query(
      'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
      ['DocuMind Processing Org B', 'documind-proc-b']
    );
    orgAId = resOrgA.rows[0].id;
    orgBId = resOrgB.rows[0].id;

    // 4. Create Users
    const resAdminA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['proc_admin_a@documind.test', hashedPassword, 'Admin A']
    );
    const resMemberA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['proc_member_a@documind.test', hashedPassword, 'Member A']
    );
    const resViewerA = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['proc_viewer_a@documind.test', hashedPassword, 'Viewer A']
    );
    const resAdminB = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id',
      ['proc_admin_b@documind.test', hashedPassword, 'Admin B']
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

  afterAll(async () => {
    await rabbitmqService.close();
  });

  // =========================================================================
  // 1. RabbitMQ Infrastructure & Queue Topology
  // =========================================================================
  describe('1. RabbitMQ Infrastructure & Topology', () => {
    test('RabbitMQ connection and queue assertions succeed idempotently', async () => {
      const { channel } = await rabbitmqService.connect();
      expect(channel).toBeDefined();

      // Check queues
      const mainQueue = await channel.checkQueue(env.RABBITMQ_QUEUE);
      expect(mainQueue.queue).toBe(env.RABBITMQ_QUEUE);

      const retryQueue = await channel.checkQueue(env.RABBITMQ_RETRY_QUEUE);
      expect(retryQueue.queue).toBe(env.RABBITMQ_RETRY_QUEUE);

      const dlq = await channel.checkQueue(env.RABBITMQ_DLQ);
      expect(dlq.queue).toBe(env.RABBITMQ_DLQ);
    });

    test('Publishing persistent message and consuming from queue works', async () => {
      const testMsg = { testId: 'msg-' + Date.now(), text: 'Hello RabbitMQ' };
      await rabbitmqService.publish(testMsg);

      let receivedMsg = null;
      await new Promise((resolve) => {
        rabbitmqService.channel.consume(
          env.RABBITMQ_QUEUE,
          (msg) => {
            if (msg) {
              const data = JSON.parse(msg.content.toString());
              if (data.testId === testMsg.testId) {
                receivedMsg = data;
                rabbitmqService.channel.ack(msg);
                resolve();
              } else {
                rabbitmqService.channel.nack(msg, false, true); // Requeue other messages
              }
            }
          },
          { noAck: false }
        );
      });

      expect(receivedMsg).toBeDefined();
      expect(receivedMsg.text).toBe('Hello RabbitMQ');
    });
  });

  // =========================================================================
  // 2. Text Extraction, Normalization & Chunking Units
  // =========================================================================
  describe('2. Text Extraction, Normalization & Chunking Logic', () => {
    test('PDF extractor extracts text and preserves page numbers', async () => {
      const res = await extractPdfText(samplePdf);
      expect(res.fullText).toContain('DocuMind Architecture Overview');
      expect(res.pages.length).toBeGreaterThanOrEqual(1);
    });

    test('Text normalizer strips control characters, normalizes line endings and redundant whitespace', () => {
      const dirty = 'Line 1\r\n\r\n\r\nLine 2 \t with  spaces\x00\x07\n\n\n\nLine 3';
      const clean = normalizeText(dirty);
      expect(clean).toBe('Line 1\n\nLine 2 with spaces\n\nLine 3');
    });

    test('Chunker splits text into deterministic chunks with page numbers and overlap', () => {
      const pages = [
        { pageNumber: 1, text: 'First paragraph on page one with valuable information about DocuMind.\n\nSecond paragraph on page one.' },
        { pageNumber: 2, text: 'Third paragraph on page two with technical architecture details.' },
      ];

      const chunks = createChunks(pages, { chunkSize: 80, chunkOverlap: 20 });
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // Verify structure of first chunk
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[0].content).toBeDefined();
      expect(chunks[0].pageStart).toBe(1);
      expect(chunks[0].characterCount).toBe(chunks[0].content.length);

      // Verify ordering
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex).toBe(i);
      }
    });

    test('Chunker rejects invalid configuration (chunkOverlap >= chunkSize)', () => {
      expect(() => {
        createChunks([{ pageNumber: 1, text: 'Test text' }], { chunkSize: 100, chunkOverlap: 150 });
      }).toThrow(/Invalid chunk configuration/);
    });
  });

  // =========================================================================
  // 3. Document Upload -> Job Creation & Outbox
  // =========================================================================
  describe('3. Upload Flow: Document Metadata + Processing Job + Outbox', () => {
    test('Upload PDF creates document, processing job in queued status, and publishes message', async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'architecture.pdf');

      expect(res.status).toBe(201);
      const doc = res.body.data.document;
      expect(doc.id).toBeDefined();
      expect(doc.job).toBeDefined();
      expect(doc.job.status).toBe('queued');
      expect(doc.job.stage).toBe('text_extraction');

      // Verify job in database
      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows.length).toBe(1);
      expect(jobRow.rows[0].document_id).toBe(doc.id);
      expect(jobRow.rows[0].organization_id).toBe(orgAId);
      expect(jobRow.rows[0].status).toBe('queued');

      // Verify outbox record
      const outboxRow = await pool.query('SELECT * FROM outbox_events WHERE aggregate_id = $1', [doc.id]);
      expect(outboxRow.rows.length).toBe(1);
      expect(outboxRow.rows[0].event_type).toBe('document.process');
    });
  });

  // =========================================================================
  // 4. Worker Processing Pipeline & Chunk Persistence
  // =========================================================================
  describe('4. Worker Processing Pipeline Execution', () => {
    let uploadedDoc;

    beforeAll(async () => {
      const res = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'processing-pipeline-doc.pdf');
      uploadedDoc = res.body.data.document;
    });

    test('Worker processes job: claims job, extracts text, creates chunks, updates status to ready & completed', async () => {
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

      // Verify job status is completed
      const jobRes = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [uploadedDoc.job.id]);
      expect(jobRes.rows[0].status).toBe('completed');
      expect(jobRes.rows[0].attempts).toBe(1);
      expect(jobRes.rows[0].finished_at).not.toBeNull();

      // Verify document status is ready
      const docRes = await pool.query('SELECT * FROM documents WHERE id = $1', [uploadedDoc.id]);
      expect(docRes.rows[0].status).toBe('ready');

      // Verify chunks were stored in document_chunks
      const chunksRes = await pool.query(
        'SELECT * FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index ASC',
        [uploadedDoc.id]
      );
      expect(chunksRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(chunksRes.rows[0].organization_id).toBe(orgAId);
      expect(chunksRes.rows[0].content).toContain('DocuMind Architecture');
    });

    test('GET /api/documents/:documentId/processing returns accurate processing status and chunk count', async () => {
      const res = await requestWithAuth(viewerAToken, orgAId).get(`/api/documents/${uploadedDoc.id}/processing`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.documentId).toBe(uploadedDoc.id);
      expect(res.body.data.documentStatus).toBe('ready');
      expect(res.body.data.job.status).toBe('completed');
      expect(res.body.data.chunkCount).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 5. Idempotency & Concurrency
  // =========================================================================
  describe('5. Job Idempotency & Duplicate Delivery Protection', () => {
    test('Processing the same job a second time does not duplicate chunks or alter completed status', async () => {
      // 1. Upload and process a new document
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'idempotency-doc.pdf');
      const doc = uploadRes.body.data.document;

      let ackCount = 0;
      const controls = {
        ack: () => { ackCount++; },
        nack: () => {},
        retry: () => {},
      };

      const payload = {
        event: 'document.process',
        jobId: doc.job.id,
        documentId: doc.id,
        organizationId: orgAId,
        version: 1,
      };

      // First processing execution
      await processor.processJob(payload, controls);
      expect(ackCount).toBe(1);

      const firstChunks = await pool.query('SELECT * FROM document_chunks WHERE document_id = $1', [doc.id]);
      const initialChunkCount = firstChunks.rows.length;

      // Second duplicate delivery
      await processor.processJob(payload, controls);
      expect(ackCount).toBe(2);

      const secondChunks = await pool.query('SELECT * FROM document_chunks WHERE document_id = $1', [doc.id]);
      expect(secondChunks.rows.length).toBe(initialChunkCount);
    });

    test('Two concurrent workers attempting to claim the same queued job allows only one to process', async () => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'concurrency-test.pdf');
      const doc = uploadRes.body.data.document;

      const worker1 = new DocumentProcessor('worker-alpha');
      const worker2 = new DocumentProcessor('worker-beta');

      const payload = {
        event: 'document.process',
        jobId: doc.job.id,
        documentId: doc.id,
        organizationId: orgAId,
        version: 1,
      };

      let worker1Ack = false;
      let worker2Ack = false;

      // Run both concurrently
      await Promise.all([
        worker1.processJob(payload, { ack: () => { worker1Ack = true; }, nack: () => {}, retry: () => {} }),
        worker2.processJob(payload, { ack: () => { worker2Ack = true; }, nack: () => {}, retry: () => {} }),
      ]);

      expect(worker1Ack).toBe(true);
      expect(worker2Ack).toBe(true);

      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows[0].status).toBe('completed');
      expect(jobRow.rows[0].attempts).toBe(1); // Only attempted once
    });
  });

  // =========================================================================
  // 6. Cross-Tenant Isolation & Anti-Spoofing in Worker
  // =========================================================================
  describe('6. Cross-Tenant Isolation & Worker Tenant Safety', () => {
    let docA, docB;

    beforeAll(async () => {
      const resA = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'tenant-a-secret.pdf');
      docA = resA.body.data.document;

      const resB = await requestWithAuth(adminBToken, orgBId)
        .post('/api/documents')
        .attach('file', samplePdf, 'tenant-b-secret.pdf');
      docB = resB.body.data.document;

      // Process both
      await processor.processJob({ event: 'document.process', jobId: docA.job.id, documentId: docA.id, organizationId: orgAId }, { ack: () => {}, nack: () => {}, retry: () => {} });
      await processor.processJob({ event: 'document.process', jobId: docB.job.id, documentId: docB.id, organizationId: orgBId }, { ack: () => {}, nack: () => {}, retry: () => {} });
    });

    test('PostgreSQL RLS prevents Tenant A from reading Tenant B chunks directly', async () => {
      // Run query within Tenant A transaction context
      const tenantAChunks = await withTenantTransaction(orgAId, async (client) => {
        return await chunkRepo.listByDocumentId(client, docB.id);
      });

      expect(tenantAChunks.length).toBe(0);
    });

    // Phase 3.4 (approved): the message's organizationId selects the tenant transaction; RLS makes
    // another organization's job invisible, so a spoofed, missing or malformed organizationId is
    // "job not found" — dead-lettered, acknowledged, and nothing of either tenant is touched.
    test.each([
      ['spoofed (organization B)', () => orgBId],
      ['missing', () => undefined],
      ['malformed', () => 'not-a-uuid'],
    ])('Worker dead-letters a %s organizationId as job not found and touches nothing', async (_label, orgOf) => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'spoof-worker-test.pdf');
      const doc = uploadRes.body.data.document;

      const spoofedPayload = { event: 'document.process', jobId: doc.job.id, documentId: doc.id, version: 1 };
      if (orgOf() !== undefined) spoofedPayload.organizationId = orgOf();

      const dlqSpy = jest.spyOn(rabbitmqService, 'publishDeadLetter').mockResolvedValue(true);
      let acked = false;
      await processor.processJob(spoofedPayload, { ack: () => { acked = true; }, nack: () => {}, retry: () => {} });
      expect(acked).toBe(true);
      expect(dlqSpy).toHaveBeenCalledWith(spoofedPayload, 'Job record not found in PostgreSQL');
      dlqSpy.mockRestore(); // after the assertion: restoring clears the recorded calls

      // Neither tenant was touched: no chunks, the job was never claimed, the document never ran
      const chunks = await pool.query('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [doc.id]);
      expect(chunks.rows[0].n).toBe(0);
      const job = await pool.query('SELECT status, attempts, worker_id FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(job.rows[0]).toEqual({ status: 'queued', attempts: 0, worker_id: null });
      const docRow = await pool.query('SELECT status FROM documents WHERE id = $1', [doc.id]);
      expect(docRow.rows[0].status).not.toBe('processing');

      // The same job with the CORRECT organization still processes normally afterwards
      await processor.processJob({ ...spoofedPayload, organizationId: orgAId }, { ack: () => {}, nack: () => {}, retry: () => {} });
      const after = await pool.query('SELECT organization_id FROM document_chunks WHERE document_id = $1', [doc.id]);
      expect(after.rows.length).toBeGreaterThan(0);
      expect(after.rows.every(r => r.organization_id === orgAId)).toBe(true);
    });
  });

  // =========================================================================
  // 7. Failure, Retry & Dead-Letter Queue (DLQ) Handling
  // =========================================================================
  describe('7. Failure, Exponential Backoff & Dead-Letter Queue (DLQ)', () => {
    test('Transient failure (e.g. MinIO temporary error) triggers retry with backoff and updates job status', async () => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'retry-test-doc.pdf');
      const doc = uploadRes.body.data.document;

      // Mock MinIO stream failure to simulate transient network blip
      const minioSpy = jest.spyOn(minioService, 'getObjectStream').mockRejectedValueOnce(new Error('MinIO temporary connection timeout'));

      let retriedWithDelay = null;
      const controls = {
        ack: () => {},
        nack: () => {},
        retry: (delayMs) => { retriedWithDelay = delayMs; },
      };

      const payload = {
        event: 'document.process',
        jobId: doc.job.id,
        documentId: doc.id,
        organizationId: orgAId,
        version: 1,
      };

      await processor.processJob(payload, controls);

      expect(retriedWithDelay).toBe(2000); // Attempt 1 delay = 2000ms

      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows[0].status).toBe('retrying');
      expect(jobRow.rows[0].attempts).toBe(1);

      minioSpy.mockRestore();
    });

    test('Permanent failure (e.g. file missing extractable text) routes to DLQ and marks job & document FAILED', async () => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', emptyPdf, 'no-text.pdf');
      const doc = uploadRes.body.data.document;

      const dlqSpy = jest.spyOn(rabbitmqService, 'publishDeadLetter');
      let acked = false;

      const payload = {
        event: 'document.process',
        jobId: doc.job.id,
        documentId: doc.id,
        organizationId: orgAId,
        version: 1,
      };

      await processor.processJob(payload, { ack: () => { acked = true; }, nack: () => {}, retry: () => {} });

      expect(acked).toBe(true);
      expect(dlqSpy).toHaveBeenCalled();

      const jobRow = await pool.query('SELECT * FROM document_processing_jobs WHERE id = $1', [doc.job.id]);
      expect(jobRow.rows[0].status).toBe('failed');
      expect(jobRow.rows[0].error_log).toMatch(/no extractable text/i);

      const docRow = await pool.query('SELECT * FROM documents WHERE id = $1', [doc.id]);
      expect(docRow.rows[0].status).toBe('failed');

      // Verify audit log row was recorded successfully without FK errors
      const auditRes = await pool.query(
        "SELECT * FROM audit_logs WHERE resource_id = $1 AND action = 'DOCUMENT_PROCESSING_FAILED'",
        [doc.id]
      );
      expect(auditRes.rows.length).toBe(1);
      expect(auditRes.rows[0].organization_id).toBe(orgAId);
      expect(auditRes.rows[0].actor_id).toBeNull();
      expect(auditRes.rows[0].metadata.jobId).toBe(doc.job.id);
      expect(auditRes.rows[0].metadata.workerId).toBe(processor.workerId);
      expect(auditRes.rows[0].metadata.error).toMatch(/no extractable text/i);

      dlqSpy.mockRestore();
    });

    test('Reprocess endpoint allows queuing a fresh processing job after failure', async () => {
      const uploadRes = await requestWithAuth(adminAToken, orgAId)
        .post('/api/documents')
        .attach('file', samplePdf, 'reprocess-test.pdf');
      const doc = uploadRes.body.data.document;

      const reprocessRes = await requestWithAuth(adminAToken, orgAId)
        .post(`/api/documents/${doc.id}/reprocess`);

      expect(reprocessRes.status).toBe(200);
      expect(reprocessRes.body.data.jobId).toBeDefined();
      expect(reprocessRes.body.data.status).toBe('queued');
    });
  });
});
