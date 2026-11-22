/**
 * A sub-agent stopped by the monthly token limit must be reported as failed,
 * not hand its stop message to the parent as its answer.
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
  initializeWorkspaceSync: () => ({ workspaceSync: {}, hook: {} }),
  resolveSkillsPaths: async () => [],
}));
const testLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: testLogger,
  createLogger: () => testLogger,
}));

const { subAgentTaskManager } = await import('../sub-agent-task-manager.js');
const { resetInFlight } = await import('../../libs/health/in-flight.js');

const { getCurrentContext } = await import('../../libs/context/request-context.js');

const agentDef = { systemPrompt: 'sp', enabledTools: [], modelId: 'm' };

async function settled(taskId: string) {
  for (let i = 0; i < 50; i++) {
    const task = await subAgentTaskManager.getTask(taskId);
    if (task && (task.status === 'completed' || task.status === 'failed')) return task;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} never settled`);
}

describe('sub-agent tasks and the token limit', () => {
  beforeEach(() => {
    resetInFlight();
    jest.clearAllMocks();
    getAgentDefinition.mockResolvedValue(agentDef);
  });

  it('reports a task the hook stopped as failed, with the reason', async () => {
    invoke.mockImplementation(async () => {
      // What TokenLimitHook does on the sub-agent's (restored) request context.
      getCurrentContext()!.tokenLimitStopped = {
        code: 'tokenLimitReached',
        message: 'The monthly token limit for m was reached.',
      };
      return '[Stopped: ...]';
    });
    const task = await settled(await subAgentTaskManager.createTask('agent-a', 'q'));
    expect(task.status).toBe('failed');
    expect(task.error).toContain('monthly token limit');
    expect(task.result).toBeUndefined();
  });

  it('completes normally when the limit did not interfere', async () => {
    invoke.mockResolvedValue('the answer');
    const task = await settled(await subAgentTaskManager.createTask('agent-a', 'q'));
    expect(task.status).toBe('completed');
    expect(task.result).toBe('the answer');
  });
});
