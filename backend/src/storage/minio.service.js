const Minio = require('minio');
const env = require('../config/env');

class MinioService {
  constructor() {
    this.client = new Minio.Client({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
    });
    this.defaultBucket = env.MINIO_BUCKET;
  }

  /**
   * Idempotently ensures that the target bucket exists.
   * @param {string} [bucketName]
   * @returns {Promise<void>}
   */
  async ensureBucketExists(bucketName = this.defaultBucket) {
    try {
      const exists = await this.client.bucketExists(bucketName);
      if (!exists) {
        await this.client.makeBucket(bucketName);
      }
    } catch (err) {
      // Handle race condition or duplicate creation gracefully
      if (err.code === 'BucketAlreadyOwnedByYou' || err.code === 'BucketAlreadyExists') {
        return;
      }
      throw err;
    }
  }

  /**
   * Upload an object buffer to MinIO.
   * @param {string} storageKey
   * @param {Buffer} buffer
   * @param {string} mimeType
   * @param {object} [metadata]
   * @param {string} [bucketName]
   * @returns {Promise<object>}
   */
  async uploadObject(storageKey, buffer, mimeType, metadata = {}, bucketName = this.defaultBucket) {
    const meta = {
      'Content-Type': mimeType,
      ...metadata,
    };
    return await this.client.putObject(bucketName, storageKey, buffer, buffer.length, meta);
  }

  /**
   * Retrieve a readable stream for the specified object.
   * @param {string} storageKey
   * @param {string} [bucketName]
   * @returns {Promise<NodeJS.ReadableStream>}
   */
  async getObjectStream(storageKey, bucketName = this.defaultBucket) {
    return await this.client.getObject(bucketName, storageKey);
  }

  /**
   * Delete an object from MinIO.
   * @param {string} storageKey
   * @param {string} [bucketName]
   * @returns {Promise<void>}
   */
  async deleteObject(storageKey, bucketName = this.defaultBucket) {
    try {
      await this.client.removeObject(bucketName, storageKey);
    } catch (err) {
      if (err.code === 'NoSuchKey' || err.code === 'NotFound') {
        return; // Already deleted / not found
      }
      throw err;
    }
  }

  /**
   * Check if an object exists in MinIO.
   * @param {string} storageKey
   * @param {string} [bucketName]
   * @returns {Promise<boolean>}
   */
  async objectExists(storageKey, bucketName = this.defaultBucket) {
    try {
      await this.client.statObject(bucketName, storageKey);
      return true;
    } catch (err) {
      if (err.code === 'NotFound' || err.code === 'NoSuchKey') {
        return false;
      }
      throw err;
    }
  }
}

module.exports = new MinioService();
