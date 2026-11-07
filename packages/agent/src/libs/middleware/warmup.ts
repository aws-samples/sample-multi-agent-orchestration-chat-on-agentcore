/**
 * Runtime warmup short-circuit middleware.
 *
 * The frontend sends a fire-and-forget `{ warmup: true, storagePath }` invoke on
 * the same session id as soon as the user starts typing. AgentCore Runtime routes
 * it to a microVM for that session (provisioning one on cold start), so the first
 * real invoke lands on an already-warm microVM.
 *
 * When `storagePath` is present, the workspace S3 pull is started in the
 * background on the cached sync the next invocation reuses (see
 * `prefetchWorkspaceSync`) — the pull dominates latency once the microVM is warm.
 *
 * Mounted AFTER `identityResolverMiddleware` (the prefetch needs the resolved
 * user / Identity Pool credentials) and BEFORE `validateInvocationMiddleware`
 * (which would 400 on the empty prompt). No session, memory, or model work runs.
 */

import type { Request, Response, NextFunction } from 'express';
import type { InvocationRequest } from '../../types/invocation-types.js';
import { requireUserId } from '../context/request-context.js';
import { prefetchWorkspaceSync } from '../../services/workspace-sync-helper.js';
import { logger } from '../logger/index.js';
import { beginInvocation, endInvocation } from '../health/in-flight.js';

export function warmupMiddleware(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as Partial<InvocationRequest> | undefined;
  if (body?.warmup !== true) {
    next();
    return;
  }

  if (body.storagePath) {
    try {
      const prefetch = prefetchWorkspaceSync(requireUserId(), body.storagePath);
      // Keep /ping HealthyBusy while the pull outlives this response, so the
      // microVM isn't treated as idle mid-download.
      beginInvocation();
      void prefetch.finally(endInvocation);
    } catch (error) {
      // Warmup is best-effort; the real invoke validates and syncs on its own.
      logger.warn({ error, storagePath: body.storagePath }, 'Workspace prefetch skipped');
    }
  }

  res.json({ status: 'warm' });
}
