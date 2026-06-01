/**
 * Shared HTTP response helpers.
 *
 * Centralizes the success envelope (`ok` + `buildMetadata`) and the low-level
 * error writer (`sendError`). Route handlers do NOT call `sendError` directly
 * for failures — they `throw new AppError(...)` and the single
 * `errorHandlerMiddleware` (which calls `sendError`) writes the response. This
 * keeps the error envelope — including the production message gate — defined
 * in exactly one place.
 *
 * Error envelope (flat):
 *   { error, message, code, requestId, timestamp, details? }
 * - `error`   — HTTP reason phrase / category (e.g. "Not Found").
 * - `message` — human-readable detail.
 * - `code`    — stable {@link ErrorCode} discriminator for clients.
 * - `requestId` / `timestamp` — correlation fields, always present.
 * - `details` — optional structured context (e.g. field violations).
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';
import { ErrorCode, ERROR_CODE_REASON, ERROR_CODE_STATUS } from './error-codes.js';

/** Standard error response body shared by every endpoint. */
export interface ErrorBody {
  error: string;
  message: string;
  code: ErrorCode;
  requestId?: string;
  timestamp: string;
  details?: unknown;
}

/** Standard correlation metadata attached to success responses. */
export interface ResponseMetadata {
  requestId?: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Build the `metadata` block used by success responses.
 * `extra` is merged in (e.g. `{ userId, count, nextToken }`).
 */
export function buildMetadata(
  req: AuthenticatedRequest,
  extra: Record<string, unknown> = {}
): ResponseMetadata {
  return {
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Build a standard success body: the resource payload plus a `metadata`
 * block. Spread the result into `res.json` / `res.status(...).json`:
 *
 *   res.json(ok(req, { agent }, { userId }));
 *   // → { agent, metadata: { requestId, timestamp, userId } }
 *
 * Top-level pagination fields (nextToken, hasMore, etc.) belong in `payload`
 * so they stay at the top level; descriptive counters go in `metaExtra`.
 */
export function ok<T extends Record<string, unknown>>(
  req: AuthenticatedRequest,
  payload: T,
  metaExtra: Record<string, unknown> = {}
): T & { metadata: ResponseMetadata } {
  return { ...payload, metadata: buildMetadata(req, metaExtra) };
}

/**
 * Write the canonical error envelope. This is the single low-level error
 * writer; it is used by `errorHandlerMiddleware`. The HTTP status defaults to
 * the code's mapping but can be overridden (e.g. UPSTREAM_ERROR as 503).
 *
 * Guards against double-send when headers were already flushed (e.g. a
 * streaming response that failed mid-flight).
 */
export function sendError(
  res: Response,
  req: AuthenticatedRequest,
  code: ErrorCode,
  message: string,
  options?: { status?: number; details?: unknown }
): void {
  if (res.headersSent) return;

  const status = options?.status ?? ERROR_CODE_STATUS[code];
  const body: ErrorBody = {
    error: ERROR_CODE_REASON[code],
    message,
    code,
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
  };
  if (options?.details !== undefined) {
    body.details = options.details;
  }
  res.status(status).json(body);
}
