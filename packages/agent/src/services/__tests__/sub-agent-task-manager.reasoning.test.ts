import { describe, expect, it, jest } from '@jest/globals';
import { getReasoningConfig } from '@moca/core';
import type { CreateAgentOptions } from '../../types/agent-types.js';

const createAgent = jest.fn<(options: CreateAgentOptions) => Promise<unknown>>().mockResolvedValue({
  agent: { appState: { set: jest.fn() }, invoke: jest.fn(async () => 'done') },
});

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
jest.unstable_mockModule('../agent-registry.js', () => ({
  getAgentDefinition: async () => ({
    systemPrompt: 'You are a sub-agent.',
    enabledTools: [],
    modelId: 'global.anthropic.claude-haiku-5-5',
  }),
}));
jest.unstable_mockModule('../workspace-sync-helper.js', () => ({
  resolveSkillsPaths: async () => [],
}));

const { subAgentTaskManager } = await import('../sub-agent-task-manager.js');

describe('sub-agent reasoning (Path C)', () => {
  it('passes no reasoningEffort, so Haiku 5.5 runs with the model default', async () => {
    const taskId = await subAgentTaskManager.createTask('haiku-agent', 'Summarize this');
    for (let i = 0; i < 20 && !createAgent.mock.calls.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const options = createAgent.mock.calls[0][0];
    expect(options.modelId).toBe('global.anthropic.claude-haiku-5-5');
    expect(options.reasoningEffort).toBeUndefined();
    expect(getReasoningConfig(options.modelId!, options.reasoningEffort)).toBeUndefined();
    expect((await subAgentTaskManager.getTask(taskId))?.error).toBeUndefined();
  });
});
