class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
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
