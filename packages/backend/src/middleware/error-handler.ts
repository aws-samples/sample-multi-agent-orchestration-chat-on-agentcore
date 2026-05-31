/**
 * Global error handler & 404 middleware.
 *
 * Centralizes ALL error responses so route handlers stay on the happy path
 * and simply `throw new AppError(...)`. Registered once, after all routes:
 *
 *   app.use(notFoundMiddleware);   // unmatched paths
 *   app.use(errorHandlerMiddleware); // anything thrown by the chain
 *
 * This is the single place the canonical error envelope is produced — and
 * the single place the production message gate lives, so an internal error's
 * raw message can never leak from an individual route by accident.
 *
 * Mirrors `packages/agent/src/libs/middleware/error-handler.ts`.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { AppError, ErrorCode, sendError } from '../libs/http/index.js';
import { isDevelopment } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

/**
 * 404 Not Found middleware. Registered after all routes.
 */
export function notFoundMiddleware(req: Request, res: Response): void {
  logger.warn(`404 Not Found: ${req.method} ${req.path} - ${req.ip}`);
  sendError(
    res,
    req as AuthenticatedRequest,
    ErrorCode.NOT_FOUND,
    `Endpoint ${req.method} ${req.path} not found`,
    { details: { availableEndpoints: ['GET /', 'GET /ping', 'GET /me (requires authentication)'] } }
  );
}

/**
 * Convert a ZodError into the structured `fieldViolations` shape used in the
 * error envelope's `details`.
 */
function toFieldViolations(err: ZodError): Array<{ field: string; description: string }> {
  return err.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    description: issue.message,
  }));
}

/**
 * Global error handler. Maps known error types to the canonical envelope:
 * - `AppError`        → its own code/status/details.
 * - `ZodError`        → 400 VALIDATION_ERROR with fieldViolations.
 * - body `SyntaxError`→ 400 INVALID_ARGUMENT (malformed JSON).
 * - anything else     → 500 INTERNAL_ERROR (raw message only in development).
 *
 * Safe against responses whose headers were already sent (sendError no-ops).
 */
export function errorHandlerMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const authedReq = req as AuthenticatedRequest;

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, requestId: authedReq.requestId }, 'AppError (server):');
    } else {
      logger.warn({ code: err.code, requestId: authedReq.requestId }, err.message);
    }
    sendError(res, authedReq, err.code, err.message, {
      status: err.status,
      details: err.details,
    });
    return;
  }

  if (err instanceof ZodError) {
    logger.warn({ requestId: authedReq.requestId }, 'Request validation failed');
    sendError(res, authedReq, ErrorCode.VALIDATION_ERROR, 'Request validation failed', {
      details: { fieldViolations: toFieldViolations(err) },
    });
    return;
  }

  // JSON parse error from express.json() middleware → 400 Bad Request.
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn(
      { message: err.message, path: req.path, method: req.method, ip: req.ip },
      'JSON parse error:'
    );
    sendError(res, authedReq, ErrorCode.INVALID_ARGUMENT, 'Invalid JSON in request body');
    return;
  }

  // Unknown / unexpected error → 500. Raw message only surfaced in dev.
  const detail = err instanceof Error ? err.message : String(err);
  logger.error(
    {
      err,
      requestId: authedReq.requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
    },
    'Unhandled error:'
  );
  sendError(
    res,
    authedReq,
    ErrorCode.INTERNAL_ERROR,
    isDevelopment ? detail : 'Something went wrong'
  );
}
