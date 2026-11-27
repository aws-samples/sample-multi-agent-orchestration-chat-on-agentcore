/**
 * A prompt for a session whose previous turn is still running must not start
 * a second agent loop on the mid-tool-loop history — neither in this process
 * nor in another microVM serving the same conversation (DynamoDB turn lock).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const SESSION = 'S'.repeat(33);
let requestSeq = 0;
let currentRequestId = '';

const createAgent = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  agent: {},
  metadata: {},
  retryStrategy: {},
});
let releaseFirstTurn: () => void = () => {};
const streamAgentResponse = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
let ctx: Record<string, unknown> = {};
jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: () => ctx,
  getCallerAuthorizationHeader: () => 'Bearer caller',
  requireUserId: () => 'test-user',
  requireIdentityId: () => 'test-identity',
}));
const sessions = {
  isConfigured: jest.fn(() => true),
  acquireTurnLock: jest.fn<() => Promise<unknown>>(),
  renewTurnLock: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  releaseTurnLock: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  markUserRuntimeSessionRescued: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};
jest.unstable_mockModule('../../services/sessions-service.js', () => ({
  getSessionsService: () => sessions,
}));
const stopOwnSession = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/session/session-helper.js', () => ({
  setupSession: jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ hook: {}, storage: {}, config: {} }),
}));
jest.unstable_mockModule('../../services/workspace-sync-helper.js', () => ({
  initializeWorkspaceSync: jest.fn(),
  resolveSkillsPaths: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../../services/session-persistence-deps-factory.js', () => ({
  createSessionPersistenceDeps: jest.fn(),
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.unstable_mockModule('../stream-handler.js', () => ({ streamAgentResponse }));
jest.unstable_mockModule('../../services/session-terminator.js', () => ({ stopOwnSession }));

const { handleInvocation } = await import('../invocations.js');
const { resetTurnRegistry } = await import('../../libs/health/turn-registry.js');

function createResponse() {
  return {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  } as unknown as Response & { write: jest.Mock; end: jest.Mock };
}

function invoke(res: Response, overrides: Record<string, unknown> = {}): Promise<void> {
  currentRequestId = `r${++requestSeq}`;
  ctx = {
    requestId: currentRequestId,
    sessionId: SESSION,
    runtimeSessionId: SESSION,
    runtimeSessionKind: 'user',
    identityId: 'test-identity',
    startTime: new Date(),
    ...overrides,
  };
  return handleInvocation({ body: { prompt: 'continue' } } as Request, res);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTurnRegistry();
  sessions.acquireTurnLock.mockResolvedValue({ status: 'acquired' });
  streamAgentResponse.mockImplementation(
    () => new Promise<void>((resolve) => (releaseFirstTurn = resolve))
  );
});

describe('handleInvocation per-session turn guard', () => {
  it('answers turnInProgress instead of starting a second agent loop', async () => {
    const first = invoke(createResponse());
    await new Promise((r) => setImmediate(r)); // first turn is now streaming

    const res = createResponse();
    await invoke(res);

    expect(createAgent).toHaveBeenCalledTimes(1);
    const written = JSON.parse(res.write.mock.calls[0][0] as string);
    expect(written).toMatchObject({
      type: 'serverTurnInProgressEvent',
      turn: { startedAt: expect.any(String) },
    });
    expect(res.end).toHaveBeenCalled();

    releaseFirstTurn();
    await first;
  });

  it('accepts the next prompt once the running turn has finished', async () => {
    const first = invoke(createResponse());
    await new Promise((r) => setImmediate(r));
    releaseFirstTurn();
    await first;

    streamAgentResponse.mockResolvedValue(undefined);
    await invoke(createResponse());
    expect(createAgent).toHaveBeenCalledTimes(2);
  });

  it('releases the session when the turn fails', async () => {
    createAgent.mockRejectedValueOnce(new Error('boom'));
    await expect(invoke(createResponse())).rejects.toThrow('boom');

    streamAgentResponse.mockResolvedValue(undefined);
    await invoke(createResponse());
    expect(createAgent).toHaveBeenCalledTimes(2);
  });
});

describe('handleInvocation DynamoDB turn lock', () => {
  beforeEach(() => streamAgentResponse.mockResolvedValue(undefined));

  it('answers turnInProgress when another runtime session holds the lock', async () => {
    sessions.acquireTurnLock.mockResolvedValue({
      status: 'held',
      startedAt: '2026-11-27T00:00:00.000Z',
      runner: 'machine',
    });
    const res = createResponse();
    await invoke(res);

    expect(createAgent).not.toHaveBeenCalled();
    expect(JSON.parse(res.write.mock.calls[0][0] as string)).toEqual({
      type: 'serverTurnInProgressEvent',
      turn: { startedAt: '2026-11-27T00:00:00.000Z' },
    });
    expect(stopOwnSession).not.toHaveBeenCalled();
    expect(sessions.releaseTurnLock).not.toHaveBeenCalled();
  });

  it('stops a rejected machine runtime session', async () => {
    sessions.acquireTurnLock.mockResolvedValue({ status: 'held' });
    await invoke(createResponse(), {
      isMachineUser: true,
      runtimeSessionId: `${SESSION}m`,
      runtimeSessionKind: 'machine',
    });
    expect(stopOwnSession).toHaveBeenCalledWith(`${SESSION}m`, 'Bearer caller');
  });

  it('runs unlocked when DynamoDB fails', async () => {
    sessions.acquireTurnLock.mockRejectedValue(new Error('ddb down'));
    await invoke(createResponse());
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(sessions.releaseTurnLock).not.toHaveBeenCalled();
  });

  it('releases the lock when the turn throws', async () => {
    createAgent.mockRejectedValueOnce(new Error('boom'));
    await expect(invoke(createResponse())).rejects.toThrow('boom');
    expect(sessions.releaseTurnLock).toHaveBeenCalledWith('test-identity', SESSION, ctx.requestId);
  });

  it('releases the lock before a machine session stops itself, and only once', async () => {
    const order: string[] = [];
    sessions.releaseTurnLock.mockImplementation(async () => void order.push('release'));
    stopOwnSession.mockImplementation(async () => void order.push('stop'));
    await invoke(createResponse(), {
      isMachineUser: true,
      runtimeSessionId: `${SESSION}m`,
      runtimeSessionKind: 'machine',
    });
    expect(order).toEqual(['release', 'stop']);
  });

  it('stops a machine runtime session whose turn throws, once the error response is out', async () => {
    createAgent.mockRejectedValueOnce(new Error('bad mcp config'));
    const listeners: Record<string, () => void> = {};
    const res = Object.assign(createResponse(), {
      writableEnded: false,
      once: jest.fn((event: string, fn: () => void) => (listeners[event] = fn)),
    });
    await expect(
      invoke(res, {
        isMachineUser: true,
        runtimeSessionId: `${SESSION}m`,
        runtimeSessionKind: 'machine',
      })
    ).rejects.toThrow('bad mcp config');

    expect(stopOwnSession).not.toHaveBeenCalled();
    listeners.close();
    expect(stopOwnSession).toHaveBeenCalledWith(`${SESSION}m`, 'Bearer caller');
  });

  it('keeps a human runtime session running after the turn', async () => {
    await invoke(createResponse());
    expect(stopOwnSession).not.toHaveBeenCalled();
  });

  it('records a rescued runtime session on the conversation', async () => {
    await invoke(createResponse(), {
      runtimeSessionId: `${SESSION}u`,
      runtimeSessionKind: 'rescued',
    });
    expect(sessions.markUserRuntimeSessionRescued).toHaveBeenCalledWith('test-identity', SESSION);
  });

  it('honours the body sessionType only for machine callers', async () => {
    const run = async (isMachineUser: boolean) => {
      currentRequestId = `r${++requestSeq}`;
      ctx = { requestId: currentRequestId, isMachineUser, startTime: new Date() };
      await handleInvocation(
        { body: { prompt: 'p', sessionType: 'event' } } as Request,
        createResponse()
      );
      return ctx.sessionType;
    };
    expect(await run(true)).toBe('event');
    expect(await run(false)).toBeUndefined();
  });
});
