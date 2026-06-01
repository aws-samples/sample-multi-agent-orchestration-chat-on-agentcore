/**
 * Canonical error codes for the backend HTTP API.
 *
 * Every error response carries a machine-readable `code` from this enum so
 * clients can branch on the cause without string-matching the human-facing
 * `message`. The `error` field of a response is the HTTP reason phrase
 * (category), `message` is the human-readable detail, and `code` is the
 * stable discriminator below.
 *
 * Each code maps to a default HTTP status via `ERROR_CODE_STATUS`. Callers
 * may override the status when a specific situation warrants it (e.g.
 * UPSTREAM_ERROR surfaced as 502 vs 503), but the default keeps the mapping
 * consistent across routers.
 */

/** Stable, machine-readable error discriminators returned to clients. */
export enum ErrorCode {
  // 400 — the request itself is malformed or fails validation.
  INVALID_ARGUMENT = 'INVALID_ARGUMENT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  // 401 / 403 — authentication / authorization.
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  // 404 — the addressed resource does not exist (scoped to the caller).
  NOT_FOUND = 'NOT_FOUND',
  // 409 — the request conflicts with the current state.
  CONFLICT = 'CONFLICT',
  // 413 — payload too large.
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  // 500 — the server (or a server-owned invariant) failed.
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  // 502 / 503 — a downstream dependency failed or is unavailable.
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

/** HTTP reason phrase used in the `error` field, keyed by code. */
export const ERROR_CODE_REASON: Record<ErrorCode, string> = {
  [ErrorCode.INVALID_ARGUMENT]: 'Bad Request',
  [ErrorCode.VALIDATION_ERROR]: 'Validation Error',
  [ErrorCode.UNAUTHENTICATED]: 'Unauthorized',
  [ErrorCode.FORBIDDEN]: 'Forbidden',
  [ErrorCode.NOT_FOUND]: 'Not Found',
  [ErrorCode.CONFLICT]: 'Conflict',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [ErrorCode.INTERNAL_ERROR]: 'Internal Server Error',
  [ErrorCode.CONFIGURATION_ERROR]: 'Configuration Error',
  [ErrorCode.UPSTREAM_ERROR]: 'Bad Gateway',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

/** Default HTTP status code for each error code. */
export const ERROR_CODE_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.INVALID_ARGUMENT]: 400,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.CONFIGURATION_ERROR]: 500,
  [ErrorCode.UPSTREAM_ERROR]: 502,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
};

/**
 * Application error carrying a canonical {@link ErrorCode}.
 *
 * Throw this from services/routes to signal a specific, client-facing error.
 * The shared error handler (`sendInternalError`) recognizes it and emits the
 * mapped HTTP status + code instead of a generic 500. Use `details` for
 * structured, non-sensitive context (e.g. field violations).
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { status?: number; details?: unknown; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = options?.status ?? ERROR_CODE_STATUS[code];
    this.details = options?.details;
  }
}
