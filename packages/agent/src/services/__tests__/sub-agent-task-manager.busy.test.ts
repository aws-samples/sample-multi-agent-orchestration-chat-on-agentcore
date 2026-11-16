/**
 * Sub-agent tasks are fire-and-forget and outlive the parent invocation's
 * response, so they must hold /ping at HealthyBusy until they settle.
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
const { isBusy, resetInFlight } = await import('../../libs/health/in-flight.js');

const agentDef = { systemPrompt: 'sp', enabledTools: [], modelId: 'm' };

async function waitForStatus(taskId: string, status: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await subAgentTaskManager.getTask(taskId))?.status === status) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${taskId} never reached ${status}`);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('sub-agent task busy reporting', () => {
  beforeEach(() => {
    resetInFlight();
    jest.clearAllMocks();
  });

  it('keeps the container busy from creation until the task completes', async () => {
    let finish!: (value: string) => void;
    getAgentDefinition.mockResolvedValue(agentDef);
    invoke.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));

    const taskId = await subAgentTaskManager.createTask('agent-a', 'q');
    expect(isBusy()).toBe(true);

    await waitForStatus(taskId, 'running');
    expect(isBusy()).toBe(true);

    finish('done');
    await waitForStatus(taskId, 'completed');
    await flush();
    expect(isBusy()).toBe(false);
  });

  it('releases the busy state when the task fails', async () => {
    getAgentDefinition.mockResolvedValue(null);

    const taskId = await subAgentTaskManager.createTask('missing', 'q');
    await waitForStatus(taskId, 'failed');
    await flush();
    expect(isBusy()).toBe(false);
  });
});
