/**
 * API Error Classes
 *
 * Shared error types used across API clients and error handlers.
 * Located in types/ (L0) so that utils/ (L1) can reference them
 * without depending on api/ (L2).
 */

import i18n from '../i18n';

/**
 * Custom error class for API errors
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly details?: unknown;
  /**
   * Machine-readable error code from the backend's canonical error envelope
   * (e.g. 'NOT_FOUND', 'VALIDATION_ERROR'). Present when the server includes
   * a `code` field; undefined for non-API or legacy errors. Prefer branching
   * on this over string-matching `message` or relying solely on `status`.
   */
  public readonly code?: string;

  constructor(
    message: string,
    status: number,
    statusText: string,
    details?: unknown,
    code?: string
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.details = details;
    this.code = code;
  }
}

/**
 * Custom error class for authentication errors
 */
export class AuthenticationError extends Error {
  constructor(message?: string) {
    super(message || i18n.t('error.authenticationRequired'));
    this.name = 'AuthenticationError';
  }
}
