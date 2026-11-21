/**
 * Ollama Embedding Service
 * Generates vector embeddings for text chunks using local Ollama model (nomic-embed-text).
 * Enforces strict input validation, response schema verification, and dimension consistency.
 */

const env = require('../config/env');

class EmbeddingService {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = config.model || env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
    this.expectedDimension = config.dimension || env.EMBEDDING_DIMENSION || 768;
    this.maxTextLength = 50000; // Safe character threshold per chunk
  }

  /**
   * Health check to verify Ollama server connectivity and model availability.
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!response.ok) {
        return { status: 'unhealthy', error: `Ollama HTTP ${response.status}: ${response.statusText}` };
      }
      const data = await response.json();
      const modelList = (data.models || []).map(m => m.name);
      const hasModel = modelList.some(name => name.includes(this.model));
      return {
        status: 'healthy',
        models: modelList,
        modelLoaded: hasModel,
      };
    } catch (err) {
      return { status: 'unhealthy', error: err.message };
    }
  }

  /**
   * Validates chunk input text before sending to model.
   */
  validateInput(text) {
    if (text === undefined || text === null) {
      throw new Error('Embedding input text must not be null or undefined.');
    }
    if (typeof text !== 'string') {
      throw new Error(`Embedding input must be a string, received ${typeof text}.`);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error('Embedding input text cannot be empty or whitespace only.');
    }
    if (trimmed.length > this.maxTextLength) {
      throw new Error(`Embedding input text exceeds maximum allowed size of ${this.maxTextLength} characters.`);
    }
    return trimmed;
  }

  /**
   * Validates embedding response array returned from Ollama.
   */
  validateEmbedding(embedding) {
    if (!Array.isArray(embedding)) {
      throw new Error('Ollama returned invalid embedding format: expected array.');
    }
    if (embedding.length === 0) {
      throw new Error('Ollama returned an empty embedding array.');
    }
    if (embedding.length !== this.expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.expectedDimension}, received ${embedding.length}.`
      );
    }
    for (let i = 0; i < embedding.length; i++) {
      if (typeof embedding[i] !== 'number' || isNaN(embedding[i])) {
        throw new Error(`Embedding array contains non-numeric value at index ${i}.`);
      }
    }
    return embedding;
  }

  /**
   * Generates embedding for a single text string.
   *
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embedText(text) {
    const validatedText = this.validateInput(text);

    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        signal: AbortSignal.timeout(env.OLLAMA_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: validatedText,
        }),
      });
    } catch (networkErr) {
      throw new Error(`Failed to connect to Ollama embedding service at ${this.baseUrl}: ${networkErr.message}`);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama embedding API error (${response.status}): ${errText || response.statusText}`);
    }

    const data = await response.json();
    if (!data || !data.embedding) {
      throw new Error('Ollama response is missing embedding payload.');
    }

    return this.validateEmbedding(data.embedding);
  }

  /**
   * Generates embeddings for an array of texts with concurrency control.
   *
   * @param {string[]} texts - Array of string chunks
   * @param {object} options - { concurrency: number }
   * @returns {Promise<number[][]>}
   */
  async embedTexts(texts, { concurrency = 3 } = {}) {
    if (!Array.isArray(texts)) {
      throw new Error('embedTexts expects an array of strings.');
    }
    if (texts.length === 0) {
      return [];
    }

    const results = new Array(texts.length);
    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < texts.length) {
        const index = currentIndex++;
        const embedding = await this.embedText(texts[index]);
        results[index] = embedding;
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, texts.length) }, () => worker());
    await Promise.all(workers);

    return results;
  }
}

module.exports = require('../observability/instrument').instrumentEmbeddings(new EmbeddingService());
