/**
 * `{ action: 'stop' }` side channel: stops only the caller's own turn and
 * sub-agent tasks, and never starts a turn.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockCancelTasks = jest.fn<(sessionId: string, userId: string) => number>();
jest.unstable_mockModule('../../../services/sub-agent-task-manager.js', () => ({
  subAgentTaskManager: { cancelTasksByParentSession: mockCancelTasks },
}));

const { stopTurnMiddleware } = await import('../stop-turn.js');
const { createRequestContext, runWithContext } = await import('../../context/request-context.js');
const { makeTurnCancellable, resetTurnRegistry, tryBeginTurn } =
  await import('../../health/turn-registry.js');

const SESSION = 'S'.repeat(33);

function run(body: unknown, opts: { sessionId?: string; userId?: string } = {}) {
  const ctx = createRequestContext('Bearer at');
  ctx.sessionId = opts.sessionId as never;
  ctx.userId = opts.userId as never;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  runWithContext(ctx, () =>
    stopTurnMiddleware(
      { body } as Request,
      res as unknown as Response,
      next as unknown as NextFunction
    )
  );
  return { res, next };
}

beforeEach(() => {
  resetTurnRegistry();
  mockCancelTasks.mockReset().mockReturnValue(0);
});

describe('stopTurnMiddleware', () => {
  it('passes regular prompts through', () => {
    const { next, res } = run({ prompt: 'hi' }, { sessionId: SESSION, userId: 'u1' });
    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("stops the caller's running turn and sub-agent tasks", () => {
    tryBeginTurn(SESSION, 'r1', 'u1');
    const signal = makeTurnCancellable(SESSION, 'r1');
    mockCancelTasks.mockReturnValue(2);

    const { next, res } = run({ action: 'stop' }, { sessionId: SESSION, userId: 'u1' });

    expect(next).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(mockCancelTasks).toHaveBeenCalledWith(SESSION, 'u1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      type: 'turnStopRequested',
      stopped: true,
      cancelledTasks: 2,
    });
  });

  it("answers another user's stop exactly like an idle session", () => {
    tryBeginTurn(SESSION, 'r1', 'owner');
    const signal = makeTurnCancellable(SESSION, 'r1');

    const { res } = run({ action: 'stop' }, { sessionId: SESSION, userId: 'intruder' });

    expect(signal?.aborted).toBe(false);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      type: 'turnStopRequested',
      stopped: false,
      cancelledTasks: 0,
    });
  });

  it('rejects a stop without a session id', () => {
    const { next, res } = run({ action: 'stop' }, { userId: 'u1' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
