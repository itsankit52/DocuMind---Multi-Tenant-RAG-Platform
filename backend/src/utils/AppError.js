class AppError extends Error {
  /**
   * @param {string} message      client-safe message
   * @param {number} statusCode   HTTP status
   * @param {string} [errorCode]  optional stable machine-readable code (e.g. ALREADY_ORGANIZATION_MEMBER),
   *                              returned to clients as `code`. Kept separate from `code`, which
   *                              holds PostgreSQL SQLSTATEs on driver errors.
   */
  constructor(message, statusCode, errorCode) {
    super(message);
    this.statusCode = statusCode;
    if (errorCode) this.errorCode = errorCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Normalize an unknown error for the client. AppErrors pass through; known Postgres
   * errors map to safe 4xx messages; anything else gets the generic fallback so driver /
   * constraint text never reaches the response body.
   */
  static from(err, fallbackMessage = 'Internal server error', fallbackStatus = 500) {
    if (err instanceof AppError) return err;
    if (err && err.code === '23505') return new AppError('Resource already exists.', 409);
    if (err && err.code === '22P02') return new AppError('Invalid identifier format.', 400);
    const wrapped = new AppError(fallbackMessage, fallbackStatus);
    wrapped.cause = err;
    return wrapped;
  }

  /** Human-readable message from a failed zod safeParse result. */
  static fromZod(zodError) {
    return new AppError(zodError.issues.map(i => i.message).join(', '), 400);
  }
}

module.exports = AppError;
