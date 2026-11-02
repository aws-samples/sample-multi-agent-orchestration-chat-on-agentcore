/**
 * Stop-dispatch middleware.
 *
 * A cancel command rides the same `POST /invocations` route as a normal turn
 * (AgentCore exposes only that endpoint) but carries `{ action: 'stop' }`
 * instead of a prompt. Because AgentCore does NOT propagate a client fetch
 * abort to the container, this out-of-band command is how the frontend stops a
 * running turn: session-sticky routing lands it on the same microVM, where the
 * process-global cancel registry holds the in-flight Agent.
 *
 * This middleware runs right after `requestContextMiddleware` (which has
 * authenticated the caller and populated `ctx.sessionId` from the session
 * header) and BEFORE prompt validation / identity exchange / streaming — a stop
 * needs none of those. On `action: 'stop'` it cancels and acks; anything else
 * falls through to the normal chain via `next()`.
 */

import type { Request, Response, NextFunction } from 'express';
import { cancelAgent } from '../health/agent-cancel-registry.js';
import { getCurrentContext } from '../context/request-context.js';
import { logger } from '../logger/index.js';

interface MaybeStopBody {
  action?: string;
}

export function stopDispatchMiddleware(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as MaybeStopBody | undefined;

  if (body?.action !== 'stop') {
    next();
    return;
  }

  const ctx = getCurrentContext();
  const sessionId = ctx?.sessionId;

  // A stop is meaningless without a session to target. The cancel registry is
  // keyed by sessionId, so refuse rather than cancel blindly.
  if (!sessionId) {
    logger.warn({ requestId: ctx?.requestId }, 'Stop request without a sessionId');
    res.status(400).json({ error: 'sessionId is required to stop a session' });
    return;
  }

  const cancelled = cancelAgent(sessionId);
  logger.info({ requestId: ctx?.requestId, sessionId, cancelled }, 'Stop request processed');

  // 200 either way: "nothing to cancel" (turn already finished, or this VM never
  // ran it) is a successful, idempotent no-op from the client's perspective.
  res.status(200).json(
    cancelled ? { status: 'cancelled', cancelled: true } : { status: 'not_running', cancelled: false }
  );
}
