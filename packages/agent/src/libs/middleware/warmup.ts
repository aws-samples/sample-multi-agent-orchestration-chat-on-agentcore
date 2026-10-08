/**
 * Runtime warmup short-circuit middleware.
 *
 * The frontend sends a fire-and-forget `{ warmup: true }` invoke on the same
 * session id as soon as the user starts typing. AgentCore Runtime routes it to
 * a microVM for that session (provisioning one on cold start), so the first
 * real invoke lands on an already-warm microVM.
 *
 * Mounted AFTER `requestContextMiddleware` (JWT verified — unauthenticated
 * callers cannot spin up microVMs) and BEFORE `validateInvocationMiddleware`
 * (which would 400 on the empty prompt). No session, memory, or model work runs.
 */

import type { Request, Response, NextFunction } from 'express';
import type { InvocationRequest } from '../../types/invocation-types.js';

export function warmupMiddleware(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as Partial<InvocationRequest> | undefined;
  if (body?.warmup === true) {
    res.json({ status: 'warm' });
    return;
  }
  next();
}
