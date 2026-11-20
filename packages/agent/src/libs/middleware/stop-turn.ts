/**
 * `{ action: 'stop' }` side channel on `/invocations`.
 *
 * AgentCore does not propagate a client disconnect to the container, so
 * aborting the browser's fetch leaves the turn running. The frontend instead
 * sends this command on the same Runtime session, which AgentCore routes to
 * the same microVM (as with `renewTokens`). Must run after
 * `authResolverMiddleware` (the stop is checked against the turn's owner)
 * and before `validateInvocationMiddleware`, which would reject the
 * prompt-less body.
 */

import type { Request, Response, NextFunction } from 'express';
import { getCurrentContext } from '../context/request-context.js';
import { stopTurn } from '../health/turn-registry.js';
import { logger } from '../logger/index.js';
import { subAgentTaskManager } from '../../services/sub-agent-task-manager.js';

export const STOP_TURN_ACTION = 'stop';

export function stopTurnMiddleware(req: Request, res: Response, next: NextFunction): void {
  if ((req.body as { action?: unknown } | undefined)?.action !== STOP_TURN_ACTION) {
    next();
    return;
  }
  const ctx = getCurrentContext();
  const sessionId = ctx?.sessionId;
  const userId = ctx?.userId;
  if (!sessionId || !userId) {
    res.status(400).json({ error: 'stop requires a Runtime session id' });
    return;
  }

  const stopped = stopTurn(sessionId, userId);
  // Sub-agents run detached from the turn that started them (and may outlive
  // it), so they are stopped by session rather than through the turn's signal.
  const cancelledTasks = subAgentTaskManager.cancelTasksByParentSession(sessionId, userId);
  logger.info({ requestId: ctx.requestId, sessionId, stopped, cancelledTasks }, 'Stop requested');
  // 200 either way: a turn that already finished is a successful no-op, and a
  // turn owned by someone else must look the same as no turn at all.
  res.status(200).json({ type: 'turnStopRequested', stopped, cancelledTasks });
}
