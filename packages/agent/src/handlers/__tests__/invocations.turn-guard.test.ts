/**
 * A prompt for a session whose previous turn is still running must not start
 * a second agent loop on the mid-tool-loop history (AC-5).
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
jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: () => ({ requestId: currentRequestId, sessionId: SESSION }),
  requireUserId: () => 'test-user',
  requireIdentityId: () => 'test-identity',
}));
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
}));
jest.unstable_mockModule('../stream-handler.js', () => ({ streamAgentResponse }));
jest.unstable_mockModule('../../services/session-terminator.js', () => ({
  stopOwnSession: jest.fn(),
}));
jest.unstable_mockModule('../../services/sessions-service.js', () => ({
  getSessionsService: () => ({
    checkAndUpdateRuntimeInstanceId: jest
      .fn<() => Promise<{ vmReplaced: boolean }>>()
      .mockResolvedValue({ vmReplaced: false }),
  }),
}));
jest.unstable_mockModule('../../libs/health/final-sync-registry.js', () => ({
  beginFinalSync: jest.fn(),
  endFinalSync: jest.fn(),
}));
jest.unstable_mockModule('../../libs/logger/mask-secrets.js', () => ({
  summarizeContent: (_text: string, label: string) => ({ [`${label}Chars`]: _text?.length ?? 0 }),
  LOG_CONTENT_ENABLED: false,
  maskSecrets: (t: string) => t,
}));

const { handleInvocation } = await import('../invocations.js');
const { resetTurnRegistry } = await import('../../libs/health/turn-registry.js');

function createResponse() {
  return {
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  } as unknown as Response & { write: jest.Mock; end: jest.Mock };
}

function invoke(res: Response): Promise<void> {
  currentRequestId = `r${++requestSeq}`;
  return handleInvocation({ body: { prompt: 'continue' } } as Request, res);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetTurnRegistry();
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
