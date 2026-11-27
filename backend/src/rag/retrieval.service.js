/**
 * RAG Retrieval Service
 * Implements two-stage tenant-safe document retrieval:
 * 1. Question embedding generation via Ollama (nomic-embed-text, 768 dimensions)
 * 2. Qdrant vector similarity search filtered strictly by organization_id
 * 3. PostgreSQL RLS cross-verification of chunk content and document status
 */

const env = require('../config/env');
const embeddingService = require('../embeddings/embedding.service');
const embeddingCache = require('./query-embedding-cache');
const qdrantService = require('../vector/qdrant.service');
const chunkRepo = require('../repositories/chunk.repository');
const { withTenantTransaction } = require('../db/transaction');
const AppError = require('../utils/AppError');
const logger = require('../observability/logger');

class RetrievalService {
  /**
   * Validates user question string.
   */
  validateQuestion(question) {
    if (question === undefined || question === null) {
      throw new AppError('Question must not be null or undefined.', 400);
    }
    if (typeof question !== 'string') {
      throw new AppError(`Question must be a string, received ${typeof question}.`, 400);
    }
    const trimmed = question.trim();
    if (trimmed.length === 0) {
      throw new AppError('Question cannot be empty or whitespace only.', 400);
    }
    const maxLen = env.RAG_MAX_QUESTION_LENGTH || 1000;
    if (trimmed.length > maxLen) {
      throw new AppError(`Question exceeds maximum allowed length of ${maxLen} characters.`, 400);
    }
    return trimmed;
  }

  /**
   * Retrieve relevant document chunks for a question under strict tenant context.
   *
   * @param {object} params - { organizationId, question, topK, scoreThreshold }
   * @returns {Promise<Array<object>>} - List of verified chunk objects with similarity scores
   */
  async retrieveContext({ organizationId, question, topK, scoreThreshold }) {
    if (!organizationId) {
      throw new AppError('Tenant isolation violation: organizationId is required for retrieval.', 403);
    }

    const validatedQuestion = this.validateQuestion(question);
    const k = Math.min(Math.max(1, topK || env.RAG_TOP_K || 5), 50); // Clamp between 1 and 50
    const threshold = scoreThreshold !== undefined ? scoreThreshold : (env.RAG_SCORE_THRESHOLD || 0.0);

    // Stage 1: Generate query embedding
    let queryVector;
    try {
      // Cached per organization in Redis (fail-open); retrieval below always runs live
      queryVector = await embeddingCache.getOrCompute(
        { organizationId, model: embeddingService.model, question: validatedQuestion },
        () => embeddingService.embedText(validatedQuestion),
      );
    } catch (embErr) {
      throw new AppError(`Failed to generate query embedding: ${embErr.message}`, 503);
    }

    // Stage 2: Qdrant similarity search with mandatory organization_id filter
    let searchResults;
    try {
      searchResults = await qdrantService.searchPoints(env.QDRANT_COLLECTION, {
        vector: queryVector,
        organizationId,
        limit: k * 2, // Fetch extra to allow post-filtering
      });
    } catch (qdrantErr) {
      throw new AppError(`Vector search error: ${qdrantErr.message}`, 503);
    }

    if (!searchResults || searchResults.length === 0) {
      return [];
    }

    // Filter by score threshold
    // Keep the whole over-fetched set: stale/deleted hits are dropped by the PG verification
    // below, and only then is the result trimmed to k.
    const filteredMatches = searchResults.filter(match => match.score >= threshold);
    if (filteredMatches.length === 0) {
      return [];
    }

    // Map chunk ID to Qdrant score & metadata
    const scoreMap = new Map();
    const candidateChunkIds = [];
    for (const match of filteredMatches) {
      const chunkId = match.id || match.payload?.chunk_id;
      if (chunkId) {
        scoreMap.set(chunkId, match.score);
        candidateChunkIds.push(chunkId);
      }
    }

    // Stage 3: Two-stage cross-verification in PostgreSQL under tenant RLS transaction
    const verifiedChunks = await withTenantTransaction(organizationId, async (client) => {
      const dbChunks = await chunkRepo.findChunksWithDocumentByIds(client, candidateChunkIds);

      // Defense-in-depth: Ensure every chunk strictly belongs to the authoritative organization
      const safeChunks = [];
      for (const row of dbChunks) {
        if (row.organization_id !== organizationId) {
          logger.warn('Cross-tenant chunk rejected during retrieval', {
            chunkId: row.chunk_id,
            expectedOrg: organizationId,
          });
          continue;
        }

        const score = scoreMap.get(row.chunk_id) || 0;
        safeChunks.push({
          chunkId: row.chunk_id,
          documentId: row.document_id,
          organizationId: row.organization_id,
          documentName: row.original_name || row.filename || 'Document',
          chunkIndex: row.chunk_index,
          pageStart: row.page_start,
          pageEnd: row.page_end,
          characterCount: row.character_count,
          content: row.content,
          score: typeof score === 'number' ? Number(score.toFixed(4)) : 0,
        });
      }

      // Sort by similarity score descending
      safeChunks.sort((a, b) => b.score - a.score);
      return safeChunks.slice(0, k);
    });

    return verifiedChunks;
  }
}

module.exports = require('../observability/instrument').instrumentRetrieval(new RetrievalService());
