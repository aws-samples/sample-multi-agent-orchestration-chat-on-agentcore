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
import type { ParamsDictionary } from 'express-serve-static-core';
import type { AuthenticatedRequest } from '../types/index.js';

type AsyncRequestHandler<P = ParamsDictionary> = (
  req: AuthenticatedRequest<P>,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

/**
 * Wraps an async Express handler so rejected promises are forwarded to
 * Express error middleware via `next(error)`.
 *
 * Generic over the route params type `P`, inferred from the handler. This
 * lets callers annotate typed path params (e.g.
 * `AuthenticatedRequest<{ agentId: string }>`) without the wrapper widening
 * them back to `ParamsDictionary`.
 */
export function asyncHandler<P = ParamsDictionary>(fn: AsyncRequestHandler<P>) {
  return (req: AuthenticatedRequest<P>, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
