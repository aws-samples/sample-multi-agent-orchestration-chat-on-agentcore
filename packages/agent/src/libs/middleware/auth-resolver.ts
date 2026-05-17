/**
 * Authentication resolver middleware
 *
 * Resolves the effective user ID from the current `RequestContext` and
 * enriches the context with:
 *   - `userId` (effective actor, branded as `UserId`)
 *   - `storagePath` (only when the request body provides one —
 *     `createRequestContext` already seeds it to `'/'`)
 *
 * On resolution failure responds with the appropriate 4xx status and
 * short-circuits the chain. Must run after `requestContextMiddleware`.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/index.js';
import type { InvocationRequest } from '../../types/invocation-types.js';
import { resolveEffectiveUserId } from '../auth/index.js';
import { getCurrentContext } from '../context/request-context.js';

/**
 * Express middleware that resolves the effective userId and enriches the
 * request-scoped context.
 */
export function authResolverMiddleware(req: Request, res: Response, next: NextFunction): void {
  const body = (req.body ?? {}) as InvocationRequest;
  const context = getCurrentContext();

  if (!context) {
    // `requestContextMiddleware` must run first; bail out clearly.
    logger.error('authResolverMiddleware invoked without RequestContext');
    res.status(500).json({ error: 'Request context is not initialized' });
    return;
  }

  const userIdResult = resolveEffectiveUserId(context, body.targetUserId);
  if (userIdResult.error || !userIdResult.userId) {
    const error = userIdResult.error ?? {
      status: 401,
      message: 'Authenticated user ID could not be resolved',
    };
    logger.warn(
      {
        requestId: context.requestId,
        error: error.message,
      },
      'User ID resolution failed:'
    );
    res.status(error.status).json({ error: error.message });
    return;
  }

  // Enrich context for downstream handlers / services. `userId` is
  // already branded as `UserId` at this point, so the compiler can
  // enforce "no raw strings flow into data-access sites" below.
  context.userId = userIdResult.userId;
  if (body.storagePath) {
    context.storagePath = body.storagePath;
  }

  next();
}
