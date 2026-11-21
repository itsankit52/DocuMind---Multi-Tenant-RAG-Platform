/**
 * Qdrant Vector Store Service
 * Dedicated service for interacting with Qdrant Vector Database via HTTP REST API.
 * Enforces strict multi-tenant isolation and deterministic point IDs.
 */

const env = require('../config/env');

class QdrantService {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || env.QDRANT_URL || 'http://localhost:6333';
    this.collectionName = config.collectionName || env.QDRANT_COLLECTION || 'documind_chunks';
    this.apiKey = config.apiKey !== undefined ? config.apiKey : (env.QDRANT_API_KEY || '');
    this.dimension = config.dimension || env.EMBEDDING_DIMENSION || 768;
  }

  /**
   * Helper to execute HTTP requests to Qdrant REST API.
   */
  async _request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      ...(options.headers || {}),
    };

    // Qdrant closes idle keep-alive sockets after 5s; fetch may reuse one at that instant
    // and fail before the request is processed. All operations here are idempotent
    // (deterministic point IDs), so one immediate retry on a network-level error is safe.
    let response;
    for (let attempt = 1; ; attempt++) {
      try {
        const timeout = AbortSignal.timeout(env.QDRANT_TIMEOUT_MS);
        response = await fetch(url, {
          ...options,
          headers,
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        });
        break;
      } catch (networkErr) {
        if (attempt >= 2 || (options.signal && options.signal.aborted)) {
          throw new Error(`Qdrant connection error: ${networkErr.message}`);
        }
      }
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const errMsg = data?.status?.error || data?.message || text || response.statusText;
      throw new Error(`Qdrant API error (${response.status}): ${errMsg}`);
    }

    return data;
  }

  /**
   * Health check for Qdrant service.
   */
  async healthCheck() {
    try {
      const res = await this._request('/healthz', { method: 'GET' });
      return { status: 'healthy', data: res };
    } catch (err) {
      return { status: 'unhealthy', error: err.message };
    }
  }

  /**
   * Check if a collection exists.
   */
  async collectionExists(collectionName = this.collectionName) {
    try {
      const res = await this._request(`/collections/${collectionName}`, { method: 'GET' });
      return res?.result?.status !== undefined;
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('Not found') || err.message.includes('doesn\'t exist')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Ensure the collection exists with specified dimensions and cosine distance metric.
   */
  async ensureCollection(collectionName = this.collectionName, dimension = this.dimension, distance = 'Cosine') {
    const exists = await this.collectionExists(collectionName);
    if (!exists) {
      console.log(`[Qdrant] Creating collection '${collectionName}' with vector size ${dimension} (${distance})...`);
      await this._request(`/collections/${collectionName}`, {
        method: 'PUT',
        body: JSON.stringify({
          vectors: {
            size: dimension,
            distance: distance,
          },
        }),
      });

      // Create payload indices for fast tenant-scoped filtering
      await this.createPayloadIndex(collectionName, 'organization_id', 'keyword');
      await this.createPayloadIndex(collectionName, 'document_id', 'keyword');
      console.log(`[Qdrant] Collection '${collectionName}' created successfully.`);
    }
    return true;
  }

  /**
   * Create index on a payload field for efficient filtering.
   */
  async createPayloadIndex(collectionName, fieldName, fieldSchema = 'keyword') {
    try {
      await this._request(`/collections/${collectionName}/index`, {
        method: 'PUT',
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: fieldSchema,
        }),
      });
    } catch (err) {
      // Ignore if index already exists
      if (!err.message.includes('already exists')) {
        console.warn(`[Qdrant] Note creating index on ${fieldName}:`, err.message);
      }
    }
  }

  /**
   * Get collection details.
   */
  async getCollectionInfo(collectionName = this.collectionName) {
    const res = await this._request(`/collections/${collectionName}`, { method: 'GET' });
    return res.result;
  }

  /**
   * Upsert points into Qdrant collection.
   *
   * @param {string} collectionName
   * @param {Array<{id: string, vector: number[], payload: object}>} points
   */
  async upsertPoints(collectionName = this.collectionName, points = []) {
    if (!Array.isArray(points) || points.length === 0) {
      return { status: 'acknowledged', count: 0 };
    }

    // Validate points schema and mandatory tenant payload
    for (const point of points) {
      if (!point.id) {
        throw new Error('Each Qdrant point must have a unique deterministic ID (UUID).');
      }
      if (!Array.isArray(point.vector) || point.vector.length === 0) {
        throw new Error(`Point ${point.id} has invalid or empty vector.`);
      }
      if (!point.payload || !point.payload.organization_id) {
        throw new Error(`Point ${point.id} is missing mandatory organization_id payload for tenant isolation.`);
      }
      if (!point.payload.document_id) {
        throw new Error(`Point ${point.id} is missing mandatory document_id payload.`);
      }
      if (!point.payload.chunk_id) {
        throw new Error(`Point ${point.id} is missing mandatory chunk_id payload.`);
      }
    }

    // Batch upsert into Qdrant
    const res = await this._request(`/collections/${collectionName}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: points.map(p => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload,
        })),
      }),
    });

    return {
      status: res.status || 'ok',
      result: res.result,
      count: points.length,
    };
  }

  /**
   * Retrieve a specific point by ID from Qdrant.
   */
  async getPoint(collectionName = this.collectionName, pointId) {
    if (!pointId) return null;
    try {
      const res = await this._request(`/collections/${collectionName}/points/${pointId}`, {
        method: 'GET',
      });
      return res.result || null;
    } catch (err) {
      if (err.message.includes('404') || err.message.includes('Not found')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete specific point IDs from Qdrant.
   */
  async deletePoints(collectionName = this.collectionName, pointIds = []) {
    if (!pointIds || pointIds.length === 0) return { status: 'acknowledged' };
    const res = await this._request(`/collections/${collectionName}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({
        points: pointIds,
      }),
    });
    return res;
  }

  /**
   * Delete points belonging to a specific document under tenant isolation.
   *
   * @param {object} params - { organizationId, documentId, collectionName }
   */
  async deleteByDocument({ organizationId, documentId, collectionName = this.collectionName }) {
    if (!organizationId || !documentId) {
      throw new Error('organizationId and documentId are required to delete document vectors safely.');
    }

    const filter = {
      must: [
        { key: 'organization_id', match: { value: organizationId } },
        { key: 'document_id', match: { value: documentId } },
      ],
    };

    const res = await this._request(`/collections/${collectionName}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({ filter }),
    });

    return res;
  }

  /**
   * Build tenant-safe filter ensuring organization_id is always strictly enforced.
   */
  buildTenantFilter(organizationId, additionalMust = []) {
    if (!organizationId) {
      throw new Error('Cannot build Qdrant filter without authoritative organizationId.');
    }

    return {
      must: [
        { key: 'organization_id', match: { value: organizationId } },
        ...(Array.isArray(additionalMust) ? additionalMust : []),
      ],
    };
  }

  /**
   * Search points in Qdrant with MANDATORY tenant isolation.
   *
   * @param {string} collectionName
   * @param {object} params - { vector, organizationId, limit, filter, withPayload, withVector }
   */
  async searchPoints(collectionName = this.collectionName, {
    vector,
    organizationId,
    limit = 10,
    filter = null,
    withPayload = true,
    withVector = false,
  }) {
    if (!organizationId) {
      throw new Error('Tenant isolation violation: organizationId is required for vector search.');
    }
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Query vector must be a non-empty array of numbers.');
    }

    // Combine user filter with mandatory organization_id filter
    const tenantFilter = this.buildTenantFilter(
      organizationId,
      filter?.must ? (Array.isArray(filter.must) ? filter.must : [filter.must]) : []
    );

    const body = {
      vector,
      limit,
      filter: tenantFilter,
      with_payload: withPayload,
      with_vector: withVector,
    };

    const res = await this._request(`/collections/${collectionName}/points/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return res.result || [];
  }
}

module.exports = require('../observability/instrument').instrumentQdrant(new QdrantService());
