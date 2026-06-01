/**
 * Async handler wrapper for Express.
 *
 * Express 4 does not forward rejected promises from async handlers to error
 * middleware. This utility wraps an async handler so any thrown error (or
 * rejected promise) is passed to `next()`, letting the global
 * `errorHandlerMiddleware` produce the canonical error envelope. Mirrors
 * `packages/agent/src/libs/middleware/async-handler.ts`.
 *
 * With this in place, route handlers only write the happy path and `throw`
 * an `AppError` for anything else — no per-handler try/catch.
 */

import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

type AsyncRequestHandler = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

/**
 * Wraps an async Express handler so rejected promises are forwarded to
 * Express error middleware via `next(error)`.
 */
export function asyncHandler(fn: AsyncRequestHandler) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
