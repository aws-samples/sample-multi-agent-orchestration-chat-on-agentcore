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

  constructor(message: string, status: number, statusText: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.details = details;
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
