/**
 * Identity resolver middleware
 *
 * Exchanges the authenticated Cognito `UserId` (populated by
 * `authResolverMiddleware`) for a Cognito Identity Pool `IdentityId`
 * via `getIdentityId`, and stores the result on `RequestContext` so
 * that downstream handlers / services / tools can read it through the
 * `requireIdentityId()` helper without performing their own I/O.
 *
 * Rationale: AgentCore Memory, DynamoDB and S3 are all keyed on
 * `identityId` because `${cognito-identity.amazonaws.com:sub}` is the
 * IAM policy variable that's correctly expanded against credentials
 * issued by `GetCredentialsForIdentity`. Resolving it here — once per
 * request, before any data-access site runs — keeps downstream call
 * sites short and uniformly typed (branded `IdentityId`).
 *
 * Must run after `authResolverMiddleware` (requires `context.userId`)
 * and before any middleware that touches per-user AWS resources
 * (i.e. the route handler).
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/index.js';
import { getCurrentContext } from '../context/request-context.js';
import { getIdentityId } from '../utils/scoped-credentials.js';

/**
 * Express middleware that resolves the Cognito Identity Pool
 * identityId and caches it on `RequestContext.identityId`.
 */
export function identityResolverMiddleware(req: Request, res: Response, next: NextFunction): void {
  const context = getCurrentContext();
  if (!context?.userId) {
    logger.error('identityResolverMiddleware invoked before userId was resolved');
    res.status(500).json({ error: 'User ID is not resolved' });
    return;
  }

  // `getIdentityId` internally writes to `context.identityId` (see
  // `scoped-credentials.ts`). We await it here so any exception surfaces
  // as a 401 / 5xx before the route handler begins streaming.
  getIdentityId(context.userId)
    .then(() => {
      next();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          requestId: context.requestId,
          userId: context.userId,
          error: message,
        },
        'identityResolverMiddleware failed to resolve identityId:'
      );
      res.status(401).json({
        error: 'Failed to resolve Cognito Identity Pool identity',
        requestId: context.requestId,
      });
    });
}
