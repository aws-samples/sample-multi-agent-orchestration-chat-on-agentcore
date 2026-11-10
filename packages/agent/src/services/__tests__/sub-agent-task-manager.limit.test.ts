/**
 * The per-session limit is a concurrency limit: only tasks that are still
 * pending or running may count against it. A finished task, whether it
 * completed or failed, must free its slot; otherwise five failures block the
 * session from starting any further sub-agent for the life of the process.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const invoke = jest.fn<() => Promise<string>>();
const createAgent = jest.fn(async () => ({ agent: { appState: { set: jest.fn() }, invoke } }));
const getAgentDefinition = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
jest.unstable_mockModule('../agent-registry.js', () => ({
  listAgents: async () => [],
  getAgentDefinition,
}));
jest.unstable_mockModule('../workspace-sync-helper.js', () => ({
  resolveSkillsPaths: async () => [],
}));
const testLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: testLogger,
  createLogger: () => testLogger,
}));

const { subAgentTaskManager } = await import('../sub-agent-task-manager.js');
const { resetInFlight } = await import('../../libs/health/in-flight.js');

const agentDef = { systemPrompt: 'sp', enabledTools: [], modelId: 'm' };
const LIMIT = 5;

async function waitForStatus(taskId: string, status: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await subAgentTaskManager.getTask(taskId))?.status === status) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} never reached ${status}`);
}

describe('sub-agent task limit per session', () => {
  beforeEach(() => {
    resetInFlight();
    jest.clearAllMocks();
    getAgentDefinition.mockResolvedValue(agentDef);
  });

  it('rejects a new task while the limit of active tasks is reached', async () => {
    invoke.mockReturnValue(new Promise<string>(() => {}));
    const parentSessionId = 'parent-active';

    for (let i = 0; i < LIMIT; i++) {
      await subAgentTaskManager.createTask('agent-a', 'q', { parentSessionId });
    }

    await expect(
      subAgentTaskManager.createTask('agent-a', 'q', { parentSessionId })
    ).rejects.toThrow('Maximum concurrent tasks');
  });

  it('does not count failed tasks against the limit', async () => {
    invoke.mockRejectedValue(new Error('boom'));
    const parentSessionId = 'parent-failed';

    for (let i = 0; i < LIMIT; i++) {
      const taskId = await subAgentTaskManager.createTask('agent-a', 'q', { parentSessionId });
      await waitForStatus(taskId, 'failed');
    }

    await expect(
      subAgentTaskManager.createTask('agent-a', 'q', { parentSessionId })
    ).resolves.toEqual(expect.any(String));
  });
});
