const crypto = require('crypto');
const { uuidv7 } = require('uuidv7');
const minioService = require('../storage/minio.service');
const rabbitmqService = require('../queue/rabbitmq.service');
const qdrantService = require('../vector/qdrant.service');
const docRepo = require('../repositories/document.repository');
const jobRepo = require('../repositories/job.repository');
const chunkRepo = require('../repositories/chunk.repository');
const outboxRepo = require('../repositories/outbox.repository');
const auditRepo = require('../repositories/audit.repository');
const { withTenantTransaction } = require('../db/transaction');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { isDocx } = require('./docx-signature');

function sanitizeFilename(originalName) {
  if (!originalName || typeof originalName !== 'string') {
    return 'document.bin';
  }
  // Strip path traversal and directory separators
  const basename = originalName.replace(/^.*[\\\/]/, '');
  // Replace unsafe characters with underscore, keeping dot, hyphen, alphanumeric
  const sanitized = basename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'document.bin';
}

function validateFile(file) {
  if (!file) {
    throw new AppError('No file provided for upload.', 400);
  }

  const maxSizeBytes = (env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024;
  if (file.size > maxSizeBytes) {
    throw new AppError(`File size exceeds maximum limit of ${env.MAX_FILE_SIZE_MB}MB.`, 413);
  }

  if (!file.buffer || file.size === 0 || file.buffer.length === 0) {
    throw new AppError('Cannot upload an empty file.', 400);
  }

  const ext = (file.originalname || '').split('.').pop().toLowerCase();
  const allowedExtensions = ['pdf', 'docx'];
  if (!allowedExtensions.includes(ext)) {
    throw new AppError(`Unsupported file extension '.${ext}'. Allowed extensions: .pdf, .docx.`, 400);
  }

  const allowedMimeTypes = [
    'application/pdf',
    'application/x-pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream',
    'application/zip',
  ];
  if (file.mimetype && !allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
    throw new AppError(`Unsupported MIME type '${file.mimetype}'. Allowed types: PDF, DOCX.`, 400);
  }

  // Magic bytes inspection
  const buf = file.buffer;
  if (ext === 'pdf') {
    const isPdf = buf.length >= 4 && buf.slice(0, 4).toString() === '%PDF';
    if (!isPdf) {
      throw new AppError('Invalid PDF file content.', 400);
    }
  } else if (ext === 'docx') {
    // Must be a ZIP whose directory lists the OOXML parts of a Word document (not just "PK")
    if (!isDocx(buf)) {
      throw new AppError('Invalid DOCX file content.', 400);
    }
  }
}

class DocumentService {
  /**
   * Upload a document:
   * 1. Validate file
   * 2. Compute SHA-256 checksum
   * 3. Generate server-side UUID and tenant-scoped object key
   * 4. Upload to MinIO
   * 5. Insert metadata, processing job, and outbox event into PostgreSQL with RLS
   * 6. Consistent rollback: If PostgreSQL insert fails, delete MinIO object
   * 7. Publish processing job to RabbitMQ
   */
  async uploadDocument({ userId, orgId, file }) {
    validateFile(file);

    const documentId = uuidv7();
    const jobId = uuidv7();
    const safeName = sanitizeFilename(file.originalname);
    const storageKey = `organizations/${orgId}/documents/${documentId}/original/${safeName}`;
    const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

    const mimeType = file.mimetype === 'application/octet-stream' || !file.mimetype
      ? (file.originalname.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      : file.mimetype;

    // Step 1: Upload to MinIO
    await minioService.uploadObject(storageKey, file.buffer, mimeType, {
      organizationId: orgId,
      uploadedBy: userId,
      originalName: file.originalname,
    });

    // Step 2: Insert into PostgreSQL with RLS and consistency rollback
    let result;
    try {
      result = await withTenantTransaction(orgId, async (client) => {
        const doc = await docRepo.createDocument(client, {
          id: documentId,
          organizationId: orgId,
          uploadedBy: userId,
          filename: safeName,
          originalName: file.originalname,
          mimeType,
          fileSize: file.size,
          storageKey,
          checksum,
          status: 'uploaded',
        });

        const job = await jobRepo.createJob(client, {
          id: jobId,
          documentId,
          organizationId: orgId,
          stage: 'text_extraction',
          status: 'queued',
          maxAttempts: env.MAX_PROCESSING_ATTEMPTS || 3,
        });

        const jobPayload = {
          event: 'document.process',
          jobId: job.id,
          documentId,
          organizationId: orgId,
          version: 1,
        };

        const outbox = await outboxRepo.createEvent(client, {
          organizationId: orgId,
          aggregateType: 'document',
          aggregateId: documentId,
          eventType: 'document.process',
          payload: jobPayload,
        });

        await auditRepo.log({
          organizationId: orgId,
          actorId: userId,
          action: 'DOCUMENT_UPLOAD',
          resourceId: documentId,
          metadata: {
            filename: safeName,
            fileSize: file.size,
            mimeType,
            checksum,
            jobId: job.id,
          },
        }, client); // same transaction as the change it records

        return { doc, job, outbox, jobPayload };
      });
    } catch (dbErr) {
      // Consistency cleanup: delete uploaded MinIO object if DB insert fails
      try {
        await minioService.deleteObject(storageKey);
      } catch (cleanupErr) {
        console.error('Failed to cleanup MinIO object after DB failure:', cleanupErr);
      }
      throw dbErr;
    }

    // Step 3: Publish to RabbitMQ (Transactional Outbox Publisher)
    try {
      await rabbitmqService.publish(result.jobPayload);
      await outboxRepo.markPublished({ query: (q, v) => require('../db').pool.query(q, v) }, result.outbox.id);
    } catch (pubErr) {
      console.warn('⚠️ Warning: Direct RabbitMQ publish failed, message remains in outbox:', pubErr.message);
    }

    return {
      ...result.doc,
      job: {
        id: result.job.id,
        status: result.job.status,
        stage: result.job.stage,
      },
    };
  }

  /**
   * List documents for the current tenant.
   */
  async listDocuments({ orgId, page, limit }) {
    return await withTenantTransaction(orgId, async (client) => {
      return await docRepo.listByOrganization(client, { page, limit });
    });
  }

  /**
   * Get document metadata by ID under tenant isolation.
   */
  async getDocument({ orgId, documentId }) {
    return await withTenantTransaction(orgId, async (client) => {
      const doc = await docRepo.findById(client, documentId);
      if (!doc) {
        throw new AppError('Document not found.', 404);
      }
      return doc;
    });
  }

  /**
   * Get processing status of a document.
   */
  async getProcessingStatus({ orgId, documentId }) {
    return await withTenantTransaction(orgId, async (client) => {
      const doc = await docRepo.findById(client, documentId);
      if (!doc) {
        throw new AppError('Document not found.', 404);
      }

      const latestJob = await jobRepo.getLatestByDocumentId(client, documentId);
      const chunkCount = await chunkRepo.countByDocumentId(client, documentId);

      return {
        documentId: doc.id,
        filename: doc.filename,
        documentStatus: doc.status,
        job: latestJob
          ? {
              id: latestJob.id,
              status: latestJob.status,
              stage: latestJob.stage,
              attempts: latestJob.attempts,
              maxAttempts: latestJob.max_attempts,
              errorLog: latestJob.error_log,
              startedAt: latestJob.started_at,
              finishedAt: latestJob.finished_at,
            }
          : null,
        chunkCount,
      };
    });
  }

  /**
   * Reprocess a document.
   */
  async reprocessDocument({ orgId, documentId, userId }) {
    const result = await withTenantTransaction(orgId, async (client) => {
      const doc = await docRepo.findById(client, documentId);
      if (!doc) {
        throw new AppError('Document not found.', 404);
      }

      const jobId = uuidv7();
      const job = await jobRepo.createJob(client, {
        id: jobId,
        documentId,
        organizationId: orgId,
        stage: 'text_extraction',
        status: 'queued',
        maxAttempts: env.MAX_PROCESSING_ATTEMPTS || 3,
      });

      const jobPayload = {
        event: 'document.process',
        jobId: job.id,
        documentId,
        organizationId: orgId,
        version: 1,
      };

      const outbox = await outboxRepo.createEvent(client, {
        organizationId: orgId,
        aggregateType: 'document',
        aggregateId: documentId,
        eventType: 'document.process',
        payload: jobPayload,
      });

      await auditRepo.log({
        organizationId: orgId,
        actorId: userId,
        action: 'DOCUMENT_REPROCESS_TRIGGERED',
        resourceId: documentId,
        metadata: { jobId: job.id },
      }, client); // same transaction as the change it records

      return { doc, job, outbox, jobPayload };
    });

    try {
      await rabbitmqService.publish(result.jobPayload);
      await outboxRepo.markPublished({ query: (q, v) => require('../db').pool.query(q, v) }, result.outbox.id);
    } catch (pubErr) {
      console.warn('⚠️ Warning: Direct RabbitMQ publish failed on reprocess:', pubErr.message);
    }

    return {
      message: 'Reprocessing job queued successfully',
      jobId: result.job.id,
      status: result.job.status,
    };
  }

  /**
   * Download document file stream.
   */
  async downloadDocument({ orgId, documentId }) {
    const doc = await withTenantTransaction(orgId, async (client) => {
      const d = await docRepo.findById(client, documentId);
      if (!d) {
        throw new AppError('Document not found.', 404);
      }
      return d;
    });

    const stream = await minioService.getObjectStream(doc.storage_key);
    return { stream, doc };
  }

  /**
   * Delete a document:
   * 1. Check document exists under tenant RLS and soft-delete it (committed first, so the
   *    document disappears for every reader and the worker refuses to mark it ready)
   * 2. Then remove the MinIO object and the Qdrant vectors. Doing storage cleanup only after
   *    the commit means a rollback can never leave a live row whose file is already gone.
   */
  async deleteDocument({ orgId, documentId, userId }) {
    const { doc, deletedDoc } = await withTenantTransaction(orgId, async (client) => {
      const doc = await docRepo.findById(client, documentId);
      if (!doc) {
        throw new AppError('Document not found.', 404);
      }

      // Soft delete in PostgreSQL
      const deletedDoc = await docRepo.softDelete(client, documentId);

      await auditRepo.log({
        organizationId: orgId,
        actorId: userId,
        action: 'DOCUMENT_DELETE',
        resourceId: documentId,
        metadata: {
          filename: doc.filename,
          storageKey: doc.storage_key,
        },
      }, client); // same transaction as the change it records

      return { doc, deletedDoc };
    });

    // Post-commit cleanup: failures are logged, never surfaced — the document is already
    // gone for users and the retrieval path ignores vectors of deleted documents.
    try {
      await minioService.deleteObject(doc.storage_key);
    } catch (minioErr) {
      console.warn(`[MinIO] Warning: object cleanup failed for doc ${documentId}:`, minioErr.message);
    }
    try {
      await qdrantService.deleteByDocument({ organizationId: orgId, documentId });
    } catch (qdrantErr) {
      console.warn(`[Qdrant] Warning: vector cleanup failed for doc ${documentId}:`, qdrantErr.message);
    }

    return deletedDoc;
  }

  /**
   * Update editable document metadata (e.g. filename rename).
   */
  async updateDocumentMetadata({ orgId, documentId, filename, userId }) {
    if (!filename || typeof filename !== 'string' || filename.trim().length === 0) {
      throw new AppError('Filename is required for update.', 400);
    }

    const safeName = sanitizeFilename(filename.trim());

    return await withTenantTransaction(orgId, async (client) => {
      const doc = await docRepo.findById(client, documentId);
      if (!doc) {
        throw new AppError('Document not found.', 404);
      }

      const updated = await docRepo.updateMetadata(client, documentId, { filename: safeName });

      await auditRepo.log({
        organizationId: orgId,
        actorId: userId,
        action: 'DOCUMENT_UPDATE_METADATA',
        resourceId: documentId,
        metadata: {
          previousFilename: doc.filename,
          newFilename: safeName,
        },
      }, client); // same transaction as the change it records

      return updated;
    });
  }
}

module.exports = new DocumentService();
