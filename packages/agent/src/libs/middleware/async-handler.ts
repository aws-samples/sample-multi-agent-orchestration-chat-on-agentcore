/**
 * Async handler wrapper for Express
 *
 * Express 4 does not forward rejected promises from async handlers to error middleware.
 * This utility wraps async handlers so that any thrown error is passed to next(),
 * allowing the global error handler in app.ts to process it.
 */

import type { Request, Response, NextFunction } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Wraps an async Express handler so that rejected promises
 * are forwarded to Express error middleware via next(error).
 */
export function asyncHandler(fn: AsyncRequestHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
