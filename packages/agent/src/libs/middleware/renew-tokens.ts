/**
 * `{ action: 'renewTokens' }` side channel on `/invocations`.
 *
 * A turn can outlive the Cognito tokens it started with (1 h). The frontend
 * re-sends its refreshed tokens on the same Runtime session, which AgentCore
 * routes to the same microVM; `requestContextMiddleware` has already verified
 * and recorded them (session-token-store), so all that is left is to answer
 * without starting a second agent turn. Must run before
 * `validateInvocationMiddleware`, which would reject the prompt-less body.
 */

import type { Request, Response, NextFunction } from 'express';
import { getCurrentContext } from '../context/request-context.js';

export const RENEW_TOKENS_ACTION = 'renewTokens';

export function renewTokensMiddleware(req: Request, res: Response, next: NextFunction): void {
  if ((req.body as { action?: unknown } | undefined)?.action !== RENEW_TOKENS_ACTION) {
    next();
    return;
  }
  if (!getCurrentContext()?.sessionId) {
    res.status(400).json({ error: 'renewTokens requires a Runtime session id' });
    return;
  }
  res.status(200).json({ type: 'tokensRenewed' });
}
