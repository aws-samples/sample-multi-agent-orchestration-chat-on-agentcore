/**
 * Sub-Agent Task Manager — cancellation tests
 *
 * Verifies that running sub-agent tasks can be interrupted:
 * - each task's `agent.invoke` receives a `cancelSignal`
 * - `cancelTask(taskId)` aborts that one task
 * - `cancelTasksByParentSession(parentSessionId)` aborts every running task
 *   spawned by a given parent turn (the propagation path from a cancelled
 *   main turn)
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility, mocking
 * the manager's heavy collaborators so the test exercises only the
 * cancellation registry. The session-persistence / workspace-sync branches are
 * intentionally left dormant (no AGENTCORE_MEMORY_ID, no storagePath).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ── Controllable agent: invoke() parks until its cancelSignal aborts ────
const invokeCalls: Array<{ signal?: AbortSignal }> = [];

function makeParkingAgent() {
  return {
    appState: { set: jest.fn() },
    invoke: jest.fn((_query: string, opts?: { cancelSignal?: AbortSignal }) => {
      invokeCalls.push({ signal: opts?.cancelSignal });
      return new Promise((resolve) => {
        // Resolve with a cancelled-style result when the signal fires; otherwise
        // stay pending, standing in for a long-running turn.
        opts?.cancelSignal?.addEventListener('abort', () => resolve('cancelled'));
      });
    }),
  };
}

const mockCreateAgent = jest.fn<any>();
const mockGetAgentDefinition = jest.fn<any>();

jest.unstable_mockModule('../../config/index.js', () => ({
  config: { AGENTCORE_MEMORY_ID: undefined },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.unstable_mockModule('../../agent.js', () => ({ createAgent: mockCreateAgent }));
jest.unstable_mockModule('../agent-registry.js', () => ({
  getAgentDefinition: mockGetAgentDefinition,
}));
jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: jest.fn(() => ({ userId: 'user-1' })),
  runWithContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
jest.unstable_mockModule('../workspace-sync.js', () => ({ WorkspaceSync: class {} }));
jest.unstable_mockModule('../workspace-sync-helper.js', () => ({
  resolveSkillsPaths: jest.fn(async () => []),
}));
jest.unstable_mockModule('../session/workspace-sync-hook.js', () => ({
  WorkspaceSyncHook: class {},
}));
jest.unstable_mockModule('../session/agentcore-memory-storage.js', () => ({
  AgentCoreMemoryStorage: class {},
}));
jest.unstable_mockModule('../session/session-persistence-hook.js', () => ({
  SessionPersistenceHook: class {},
}));
jest.unstable_mockModule('../session-persistence-deps-factory.js', () => ({
  createSessionPersistenceDeps: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../../libs/utils/scoped-credentials.js', () => ({
  getIdentityId: jest.fn(async () => 'region:id'),
  createUserScopedBedrockAgentCoreClient: jest.fn(async () => ({})),
}));

const { subAgentTaskManager } = await import('../sub-agent-task-manager.js');

/** Poll until `predicate` is true or time runs out. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('SubAgentTaskManager cancellation', () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    mockCreateAgent.mockReset().mockResolvedValue({ agent: makeParkingAgent() });
    mockGetAgentDefinition.mockReset().mockResolvedValue({
      systemPrompt: 'test',
      enabledTools: [],
      modelId: 'test-model',
    });
  });

  afterEach(() => {
    // Abort anything still parked so no promise leaks between tests.
    subAgentTaskManager.cancelAllTasks?.();
  });

  it('passes a cancelSignal to agent.invoke', async () => {
    await subAgentTaskManager.createTask('agent-a', 'do work', { parentSessionId: 'parent-1' });
    await waitFor(() => invokeCalls.length === 1);
    expect(invokeCalls[0].signal).toBeInstanceOf(AbortSignal);
    expect(invokeCalls[0].signal?.aborted).toBe(false);
  });

  it('cancelTask aborts the running task and marks it cancelled', async () => {
    const taskId = await subAgentTaskManager.createTask('agent-a', 'do work', {
      parentSessionId: 'parent-1',
    });
    await waitFor(() => invokeCalls.length === 1);

    subAgentTaskManager.cancelTask(taskId);

    expect(invokeCalls[0].signal?.aborted).toBe(true);
    await waitFor(async () => {
      const t = await subAgentTaskManager.getTask(taskId);
      return t?.status === 'cancelled';
    });
    const task = await subAgentTaskManager.getTask(taskId);
    expect(task?.status).toBe('cancelled');
  });

  it('cancelTasksByParentSession aborts every running task for that parent only', async () => {
    const a = await subAgentTaskManager.createTask('agent-a', 'q1', { parentSessionId: 'parent-1' });
    const b = await subAgentTaskManager.createTask('agent-b', 'q2', { parentSessionId: 'parent-1' });
    const other = await subAgentTaskManager.createTask('agent-c', 'q3', {
      parentSessionId: 'parent-2',
    });
    await waitFor(() => invokeCalls.length === 3);

    subAgentTaskManager.cancelTasksByParentSession('parent-1');

    // The two parent-1 tasks abort; parent-2 keeps running.
    const [sigA, sigB, sigOther] = invokeCalls.map((c) => c.signal);
    expect(sigA?.aborted).toBe(true);
    expect(sigB?.aborted).toBe(true);
    expect(sigOther?.aborted).toBe(false);

    const taskOther = await subAgentTaskManager.getTask(other);
    expect(taskOther?.status).toBe('running');
    // Silence unused-var lint for the ids we only needed to spawn tasks.
    expect([a, b]).toHaveLength(2);
  });
});
