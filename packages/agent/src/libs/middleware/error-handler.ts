/**
 * Global error handler & 404 middleware
 *
 * Centralised error / not-found responses so route handlers stay focused
 * on the happy path. Mirrors the backend-side layout where the final
 * `app.use(errorHandler)` catches anything thrown (including from
 * `asyncHandler`-wrapped async handlers).
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/index.js';
import { getContextMetadata } from '../context/request-context.js';

/**
 * 404 Not Found middleware. Registered after all routes.
 */
export function notFoundMiddleware(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.path} not found`,
    availableEndpoints: ['GET /', 'GET /ping', 'POST /invocations'],
  });
}

/**
 * Global error handler. Converts JSON parse errors to 400 and all other
 * unhandled errors to 500. Safe against streaming responses where headers
 * have already been sent.
 */
export function errorHandlerMiddleware(
  err: Error,
  req: Request,
  res: Response,

  _next: NextFunction
): void {
  const contextMeta = getContextMetadata();

  // JSON parse error from express.json() middleware → 400 Bad Request
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn(
      {
        message: err.message,
        path: req.path,
        method: req.method,
        requestId: contextMeta.requestId,
      },
      'JSON parse error:'
    );
    if (!res.headersSent) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid JSON in request body',
        requestId: contextMeta.requestId,
      });
    }
    return;
  }

  logger.error(
    {
      error: err,
      requestId: contextMeta.requestId,
      path: req.path,
      method: req.method,
    },
    'Unhandled error:'
  );

  // If streaming already started, headers are sent and we can't send JSON error
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      requestId: contextMeta.requestId,
    });
  }
}
