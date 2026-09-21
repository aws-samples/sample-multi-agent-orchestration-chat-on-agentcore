/**
 * call-agent — parentSessionId derivation.
 *
 * Regression test for the dead sub-agent cancel-propagation bug: start_task
 * derived parentSessionId from `agent.appState.get('sessionId')`, which is
 * never set, so every task got parentSessionId=undefined and
 * cancelTasksByParentSession(sessionId) could never match. The correct source
 * is the request context's sessionId — the same value invocations.ts passes to
 * cancelTasksByParentSession.
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockCreateTask = jest.fn<any>();
const mockGetTask = jest.fn<any>();
const mockGetCurrentContext = jest.fn<any>();

jest.unstable_mockModule('../../../services/sub-agent-task-manager.js', () => ({
  subAgentTaskManager: { createTask: mockCreateTask, getTask: mockGetTask },
}));
jest.unstable_mockModule('../../../services/agent-registry.js', () => ({
  listAgents: jest.fn(),
}));
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: mockGetCurrentContext,
}));
jest.unstable_mockModule('@moca/tool-definitions', () => ({
  callAgentDefinition: { name: 'call_agent', description: 'd', zodSchema: {} },
}));

const { handleStartTask } = await import('../call-agent.js');

/** A ToolContext-shaped stub with an appState map (sessionId intentionally absent). */
function toolContextWithState(state: Record<string, unknown> = {}) {
  return {
    agent: {
      appState: {
        get: (key: string) => state[key],
      },
    },
  } as any;
}

describe('handleStartTask parentSessionId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTask.mockResolvedValue('task-1');
    mockGetTask.mockResolvedValue({ sessionId: 'sub-session' });
  });

  it('uses the request-context sessionId as parentSessionId', async () => {
    // appState has NO 'sessionId' (mirrors production — only storagePath/subAgentDepth set).
    mockGetCurrentContext.mockReturnValue({ userId: 'user-1', sessionId: 'parent-session-123' });

    await handleStartTask(
      { agentId: 'agent-a', query: 'do work' },
      toolContextWithState({ storagePath: '/work' })
    );

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const opts = mockCreateTask.mock.calls[0][2];
    // This is the value cancelTasksByParentSession(sessionId) matches against.
    expect(opts.parentSessionId).toBe('parent-session-123');
  });

  it('leaves parentSessionId undefined when the context has no sessionId (sessionless)', async () => {
    mockGetCurrentContext.mockReturnValue({ userId: 'user-1' });

    await handleStartTask({ agentId: 'agent-a', query: 'do work' }, toolContextWithState());

    const opts = mockCreateTask.mock.calls[0][2];
    expect(opts.parentSessionId).toBeUndefined();
  });
});
