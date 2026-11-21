const crypto = require('crypto');
const { pool } = require('../db');
const { withTenantTransaction } = require('../db/transaction');
const minioService = require('../storage/minio.service');
const rabbitmqService = require('../queue/rabbitmq.service');
const embeddingService = require('../embeddings/embedding.service');
const qdrantService = require('../vector/qdrant.service');
const docRepo = require('../repositories/document.repository');
const jobRepo = require('../repositories/job.repository');
const chunkRepo = require('../repositories/chunk.repository');
const auditRepo = require('../repositories/audit.repository');
const { extractPdfText } = require('../processing/extractors/pdf.extractor');
const { extractDocxText } = require('../processing/extractors/docx.extractor');
const { normalizePages, normalizeText } = require('../processing/normalizer');
const { createChunks } = require('../processing/chunker');
const env = require('../config/env');
const logger = require('../observability/logger');
const { metrics, safe, secondsSince } = require('../observability/metrics');

/** Metrics only — never throws. */
const recordJob = (outcome, start) => safe(() => {
  metrics.processingJobs.inc({ outcome });
  if (start) metrics.processingDuration.observe({ outcome }, secondsSince(start));
});
const recordStage = (stage, start) => safe(() => metrics.processingStageDuration.observe({ stage }, secondsSince(start)));

// Carried on retried deliveries: how many times the job lookup has failed (database errors).
const LOOKUP_ATTEMPTS_HEADER = 'x-documind-lookup-attempts';

/** Thrown inside the processing transaction when this worker no longer owns the job. */
class ClaimLostError extends Error {
  constructor(jobId) {
    super(`Job ${jobId} is no longer claimed by this worker.`);
    this.name = 'ClaimLostError';
  }
}

class DocumentProcessor {
  constructor(workerId = `worker-${process.pid}`) {
    this.workerId = workerId;
  }

  /**
   * Helper to convert a readable stream into a Buffer.
   */
  async streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Processes a single document processing job message.
   *
   * @param {object} payload - { event, jobId, documentId, organizationId }
   * @param {object} controls - { ack, nack, retry }
   */
  async processJob(payload, controls) {
    // Every log line emitted while handling this message carries its jobId.
    return logger.runWithContext({ jobId: payload && payload.jobId }, () => this._processJob(payload, controls));
  }

  async _processJob(payload, controls) {
    const { ack, nack, retry, headers = {} } = controls;
    const { jobId, documentId, organizationId: queueOrgId } = payload;

    if (!jobId || !documentId) {
      console.error('❌ Permanent Failure: Job message missing required fields:', payload);
      await rabbitmqService.publishDeadLetter(payload, 'Invalid job payload: missing jobId or documentId');
      recordJob('invalid');
      return ack();
    }

    // Step 1: Look up job in PostgreSQL to get trusted tenant context and claim it
    let job;
    try {
      job = await jobRepo.findById({ query: (q, v) => pool.query(q, v) }, jobId);
    } catch (err) {
      // Bounded: after JOB_LOOKUP_MAX_ATTEMPTS the delivery is dead-lettered (never dropped).
      // The job row itself is left to stale-job recovery once the database is back.
      const lookupAttempt = (Number(headers[LOOKUP_ATTEMPTS_HEADER]) || 0) + 1;
      if (lookupAttempt >= env.JOB_LOOKUP_MAX_ATTEMPTS) {
        console.error(`❌ Job ${jobId}: database lookup failed ${lookupAttempt} times; dead-lettering:`, err.message);
        await rabbitmqService.publishDeadLetter(payload, `Job lookup failed after ${lookupAttempt} attempts: ${err.message}`);
        recordJob('failed');
        return ack();
      }
      const delayMs = Math.min(60000, 3000 * 2 ** (lookupAttempt - 1));
      console.error(`Temporary DB error fetching job ${jobId} (lookup attempt ${lookupAttempt}/${env.JOB_LOOKUP_MAX_ATTEMPTS}); retrying in ${delayMs}ms:`, err.message);
      recordJob('retried');
      return retry(delayMs, { [LOOKUP_ATTEMPTS_HEADER]: lookupAttempt });
    }

    if (!job) {
      console.error(`❌ Permanent Failure: Job ${jobId} not found in database.`);
      await rabbitmqService.publishDeadLetter(payload, 'Job record not found in PostgreSQL');
      recordJob('invalid');
      return ack();
    }

    // The message must describe the job it names; never trust a queue-supplied documentId
    // that does not belong to the job row.
    if (job.document_id !== documentId) {
      console.error(`❌ Permanent Failure: Job ${jobId} does not belong to document ${documentId}.`);
      await rabbitmqService.publishDeadLetter(payload, 'Job/document mismatch');
      recordJob('invalid');
      return ack();
    }

    // Authoritative tenant derivation from trusted DB record
    const trustedOrgId = job.organization_id;

    // Idempotency: If job is already completed or success, skip
    if (job.status === 'completed' || job.status === 'success') {
      console.log(`ℹ️ Job ${jobId} already completed. Acknowledging duplicate delivery.`);
      recordJob('duplicate');
      return ack();
    }

    // Step 2: Claim the job atomically
    const claimedJob = await jobRepo.claimJob({ query: (q, v) => pool.query(q, v) }, jobId, this.workerId);
    if (!claimedJob) {
      console.log(`ℹ️ Job ${jobId} already claimed or in progress by another worker.`);
      recordJob('skipped');
      return ack();
    }

    const currentAttempt = claimedJob.attempts;
    const maxAttempts = claimedJob.max_attempts || env.MAX_PROCESSING_ATTEMPTS || 3;

    console.log(`🚀 [${this.workerId}] Processing Job ${jobId} for Doc ${documentId} (Attempt ${currentAttempt}/${maxAttempts})`);

    // Step 3: Run processing pipeline under tenant context with RLS
    const jobStart = process.hrtime.bigint();
    safe(() => metrics.processingInProgress.inc());
    try {
      await withTenantTransaction(trustedOrgId, async (client) => {
        // Hold the job row for the whole run (released at commit/rollback, or when this process
        // dies). Stale-job recovery skips locked rows, so a slow live run is never "recovered".
        if (!(await jobRepo.lockForProcessing(client, jobId, this.workerId))) {
          throw new ClaimLostError(jobId);
        }

        // Update document status to 'processing'
        await client.query(
          "UPDATE documents SET status = 'processing', updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
          [documentId]
        );

        // Fetch document metadata
        const doc = await docRepo.findById(client, documentId);
        if (!doc) {
          throw new Error(`Document ${documentId} not found or has been deleted.`);
        }

        // Fetch file buffer from MinIO
        let stageStart = process.hrtime.bigint();
        let fileStream;
        try {
          fileStream = await minioService.getObjectStream(doc.storage_key);
        } catch (minioErr) {
          throw new Error(`Failed to retrieve file from MinIO: ${minioErr.message}`);
        }

        const buffer = await this.streamToBuffer(fileStream);
        if (!buffer || buffer.length === 0) {
          throw new Error('Retrieved file from storage is empty.');
        }
        recordStage('download', stageStart);
        stageStart = process.hrtime.bigint();

        // Extract text based on MIME type or extension
        const ext = (doc.filename || '').split('.').pop().toLowerCase();
        let extractedData;

        if (ext === 'pdf' || doc.mime_type === 'application/pdf') {
          extractedData = await extractPdfText(buffer);
        } else if (ext === 'docx' || doc.mime_type.includes('wordprocessingml') || doc.mime_type === 'application/zip') {
          extractedData = await extractDocxText(buffer);
        } else {
          throw new Error(`Unsupported document extension '.${ext}' for text extraction.`);
        }

        recordStage('extraction', stageStart);

        if (!extractedData.fullText || extractedData.fullText.trim().length === 0) {
          throw new Error('Document contains no extractable text.');
        }

        // Guard against memory exhaustion
        const maxTextBytes = (env.MAX_EXTRACTED_TEXT_MB || 20) * 1024 * 1024;
        if (Buffer.byteLength(extractedData.fullText, 'utf8') > maxTextBytes) {
          throw new Error(`Extracted text exceeded maximum allowed limit of ${env.MAX_EXTRACTED_TEXT_MB}MB.`);
        }

        // Normalize text & pages
        const normalizedPages = normalizePages(extractedData.pages);

        // Chunk text
        stageStart = process.hrtime.bigint();
        const chunks = createChunks(normalizedPages, {
          chunkSize: env.CHUNK_SIZE,
          chunkOverlap: env.CHUNK_OVERLAP,
          maxChunks: env.MAX_CHUNKS_PER_DOCUMENT,
        });

        if (chunks.length === 0) {
          throw new Error('No valid chunks generated from extracted text.');
        }
        recordStage('chunking', stageStart);
        safe(() => metrics.chunksCreated.inc(chunks.length));

        // Persist chunks atomically (delete old chunks for idempotency, then bulk insert)
        await chunkRepo.deleteByDocumentId(client, documentId);
        const insertedChunks = await chunkRepo.insertChunks(client, {
          organizationId: trustedOrgId,
          documentId,
          chunks,
        });

        // Step 3a: Embedding Generation Stage
        console.log(`[${this.workerId}] [Embedding] Starting embedding generation for ${insertedChunks.length} chunks (Doc ${documentId})...`);
        await jobRepo.updateJobStatus(client, jobId, { stage: 'embedding' });

        const chunkTexts = insertedChunks.map(c => c.content);
        stageStart = process.hrtime.bigint();
        const embeddings = await embeddingService.embedTexts(chunkTexts, { concurrency: 3 });
        console.log(`[${this.workerId}] [Embedding] Generated ${embeddings.length} embeddings successfully.`);
        recordStage('embedding', stageStart);

        // Step 3b: Vector Indexing Stage (Qdrant)
        console.log(`[${this.workerId}] [Qdrant] Indexing ${insertedChunks.length} vectors into collection '${env.QDRANT_COLLECTION}'...`);
        await jobRepo.updateJobStatus(client, jobId, { stage: 'indexing' });
        stageStart = process.hrtime.bigint();

        await qdrantService.ensureCollection(env.QDRANT_COLLECTION, env.EMBEDDING_DIMENSION);

        // Chunks were re-inserted with fresh IDs: drop this document's previous vectors so a
        // reprocess/retry never leaves stale points competing for top-k slots.
        await qdrantService.deleteByDocument({
          organizationId: trustedOrgId,
          documentId,
          collectionName: env.QDRANT_COLLECTION,
        });

        const points = insertedChunks.map((chunk, idx) => ({
          id: chunk.id, // Deterministic point ID = chunk UUID
          vector: embeddings[idx],
          payload: {
            organization_id: trustedOrgId,
            document_id: documentId,
            chunk_id: chunk.id,
            chunk_index: chunk.chunk_index,
            page_start: chunk.page_start,
            page_end: chunk.page_end,
            character_count: chunk.character_count,
            content_hash: crypto.createHash('sha256').update(chunk.content).digest('hex'),
            created_at: chunk.created_at ? new Date(chunk.created_at).toISOString() : new Date().toISOString(),
          },
        }));

        await qdrantService.upsertPoints(env.QDRANT_COLLECTION, points);
        recordStage('indexing', stageStart);
        console.log(`[${this.workerId}] [Qdrant] Successfully indexed ${points.length} vectors for Doc ${documentId}.`);

        // Mark chunks as embedded in PostgreSQL
        await chunkRepo.markChunksEmbedded(client, insertedChunks.map(c => c.id));

        // Update document status to 'ready' — unless it was deleted while we were working
        const readyRes = await client.query(
          "UPDATE documents SET status = 'ready', updated_at = now() WHERE id = $1 AND deleted_at IS NULL",
          [documentId]
        );
        if (readyRes.rowCount === 0) {
          throw new Error(`Document ${documentId} not found or has been deleted.`);
        }

        // Update job status to 'completed'
        await jobRepo.updateJobStatus(client, jobId, {
          status: 'completed',
          stage: 'completed',
          finishedAt: new Date(),
        });

        // Audit log
        await auditRepo.log({
          organizationId: trustedOrgId,
          actorId: doc.uploaded_by,
          action: 'DOCUMENT_PROCESSING_COMPLETED',
          resourceId: documentId,
          metadata: {
            jobId,
            workerId: this.workerId,
            chunkCount: chunks.length,
            vectorCount: points.length,
            numPages: extractedData.numPages,
            durationMs: Date.now() - new Date(claimedJob.started_at || Date.now()).getTime(),
          },
        });
      });

      console.log(`✅ [${this.workerId}] Job ${jobId} COMPLETED successfully for Doc ${documentId}`);
      recordJob('completed', jobStart);
      return ack();
    } catch (procErr) {
      if (procErr instanceof ClaimLostError) {
        // Another delivery owns the job now (it was recovered and re-claimed). Its owner
        // settles it; this delivery must not touch the job's status.
        console.warn(`ℹ️ [${this.workerId}] ${procErr.message} Acknowledging this delivery.`);
        recordJob('skipped');
        return ack();
      }
      console.error(`⚠️ [${this.workerId}] Processing error on Job ${jobId} (Attempt ${currentAttempt}/${maxAttempts}):`, procErr.message);

      // Check whether error is permanent or retryable
      const isPermanent =
        procErr.message.includes('not found') ||
        procErr.message.includes('Unsupported document') ||
        procErr.message.includes('no extractable text') ||
        procErr.message.includes('exceeded maximum allowed limit');

      if (!isPermanent && currentAttempt < maxAttempts) {
        // Transient error -> retry with exponential backoff
        const retryDelayMs = Math.min(60000, 2000 * Math.pow(2, currentAttempt - 1));
        console.log(`🔄 Retrying Job ${jobId} in ${retryDelayMs}ms...`);

        try {
          await jobRepo.updateJobStatus({ query: (q, v) => pool.query(q, v) }, jobId, {
            status: 'retrying',
            errorLog: procErr.message,
          });
        } catch (dbErr) {
          console.error('Error updating job status to retrying:', dbErr.message);
        }

        recordJob('retried', jobStart);
        return retry(retryDelayMs);
      } else {
        // Permanent failure or max attempts exhausted -> mark FAILED & send to DLQ
        console.error(`❌ [${this.workerId}] Job ${jobId} permanently FAILED after ${currentAttempt} attempts.`);

        try {
          await jobRepo.updateJobStatus({ query: (q, v) => pool.query(q, v) }, jobId, {
            status: 'failed',
            errorLog: procErr.message,
            finishedAt: new Date(),
          });

          // Runs outside a tenant transaction, so scope explicitly by the trusted org
          await pool.query(
            "UPDATE documents SET status = 'failed', updated_at = now() WHERE id = $1 AND organization_id = $2",
            [documentId, trustedOrgId]
          );

          // The transaction rolled back, but Qdrant is not transactional: remove any vectors
          // this attempt already upserted so a failed/deleted document leaves no orphans.
          await qdrantService.deleteByDocument({
            organizationId: trustedOrgId,
            documentId,
            collectionName: env.QDRANT_COLLECTION,
          }).catch(err => console.error('Qdrant cleanup after failure failed:', err.message));

          await auditRepo.log({
            organizationId: trustedOrgId,
            actorId: null, // System worker event has no human actor
            action: 'DOCUMENT_PROCESSING_FAILED',
            resourceId: documentId,
            metadata: {
              jobId,
              workerId: this.workerId,
              attempts: currentAttempt,
              error: procErr.message,
            },
          });
        } catch (dbErr) {
          console.error('Error recording job failure in database:', dbErr.message);
        }

        await rabbitmqService.publishDeadLetter(payload, procErr.message);
        recordJob('failed', jobStart);
        return ack();
      }
    } finally {
      safe(() => metrics.processingInProgress.dec());
    }
  }
}

module.exports = DocumentProcessor;
