/**
 * A user stop on the parent session reaches its sub-agent tasks: they run
 * detached from the parent turn, so the turn's own signal does not.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const invoke = jest.fn<(q: string, opts?: { cancelSignal?: AbortSignal }) => Promise<unknown>>();
const createAgent = jest.fn(async () => ({ agent: { appState: { set: jest.fn() }, invoke } }));
const getAgentDefinition = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
// userId is what the stop is checked against; without a Memory id the task
// skips the AWS-backed session persistence that userId would otherwise enable.
jest.unstable_mockModule('../../config/index.js', () => ({ config: {} }));
jest.unstable_mockModule('../agent-registry.js', () => ({
  listAgents: async () => [],
  getAgentDefinition,
}));
jest.unstable_mockModule('../workspace-sync-helper.js', () => ({
  initializeWorkspaceSync: () => ({ workspaceSync: {}, hook: {} }),
  resolveSkillsPaths: async () => [],
}));
const testLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: testLogger,
  createLogger: () => testLogger,
}));

const { subAgentTaskManager } = await import('../sub-agent-task-manager.js');

const agentDef = { systemPrompt: 'sp', enabledTools: [], modelId: 'm' };

async function waitForStatus(taskId: string, status: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await subAgentTaskManager.getTask(taskId))?.status === status) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} never reached ${status}`);
}

/** An agent that runs until its cancelSignal fires, like the SDK does. */
function invokeUntilCancelled() {
  invoke.mockImplementation(
    (_q, opts) =>
      new Promise((resolve) => {
        const signal = opts?.cancelSignal;
        if (signal?.aborted) resolve({ stopReason: 'cancelled' });
        signal?.addEventListener('abort', () => resolve({ stopReason: 'cancelled' }));
      })
  );
}

describe('sub-agent task cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAgentDefinition.mockResolvedValue(agentDef);
  });

  it("stops the session's running tasks for their owner", async () => {
    invokeUntilCancelled();
    const taskId = await subAgentTaskManager.createTask('agent-a', 'q', {
      parentSessionId: 'parent-1',
      userId: 'u1' as never,
    });
    await waitForStatus(taskId, 'running');

    expect(subAgentTaskManager.cancelTasksByParentSession('parent-1', 'u1')).toBe(1);
    await waitForStatus(taskId, 'cancelled');
    // Already signalled: a second stop is a no-op.
    expect(subAgentTaskManager.cancelTasksByParentSession('parent-1', 'u1')).toBe(0);
  });

  it('leaves tasks of other sessions and other users running', async () => {
    invokeUntilCancelled();
    const other = await subAgentTaskManager.createTask('agent-a', 'q', {
      parentSessionId: 'parent-2',
      userId: 'u1' as never,
    });
    const foreign = await subAgentTaskManager.createTask('agent-a', 'q', {
      parentSessionId: 'parent-3',
      userId: 'owner' as never,
    });
    await waitForStatus(other, 'running');
    await waitForStatus(foreign, 'running');

    expect(subAgentTaskManager.cancelTasksByParentSession('parent-3', 'intruder')).toBe(0);
    expect((await subAgentTaskManager.getTask(other))?.status).toBe('running');
    expect((await subAgentTaskManager.getTask(foreign))?.status).toBe('running');

    subAgentTaskManager.cancelTasksByParentSession('parent-2', 'u1');
    subAgentTaskManager.cancelTasksByParentSession('parent-3', 'owner');
  });
});
