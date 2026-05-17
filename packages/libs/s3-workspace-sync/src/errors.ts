/**
 * Base error class for all S3 workspace sync errors.
 */
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * Thrown when a storage path fails validation (path traversal, invalid chars, etc.).
 */
export class PathValidationError extends SyncError {
  constructor(message: string) {
    super(message, 'PATH_VALIDATION_ERROR');
    this.name = 'PathValidationError';
  }
}

/**
 * Thrown when an S3 operation fails.
 */
export class S3OperationError extends SyncError {
  constructor(message: string, cause?: unknown) {
    super(message, 'S3_OPERATION_ERROR', cause);
    this.name = 'S3OperationError';
  }
}
