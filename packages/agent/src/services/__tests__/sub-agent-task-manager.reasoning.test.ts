import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getReasoningConfig, type ReasoningDepth } from '@moca/core';
import { callAgentSchema } from '@moca/tool-definitions';
import type { CreateAgentOptions } from '../../types/agent-types.js';

const createAgent = jest.fn<(options: CreateAgentOptions) => Promise<unknown>>().mockResolvedValue({
  agent: { appState: { set: jest.fn() }, invoke: jest.fn(async () => 'done') },
});

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
jest.unstable_mockModule('../agent-registry.js', () => ({
  listAgents: async () => [],
  getAgentDefinition: async () => ({
    systemPrompt: 'You are a sub-agent.',
    enabledTools: [],
    modelId: 'global.anthropic.claude-haiku-5-5',
  }),
}));
jest.unstable_mockModule('../workspace-sync-helper.js', () => ({
  resolveSkillsPaths: async () => [],
}));
const warn = jest.fn();
const testLogger = { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() };
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: testLogger,
  createLogger: () => testLogger,
}));

const { subAgentTaskManager } = await import('../sub-agent-task-manager.js');
const { callAgentTool } = await import('../../runtime/tools/call-agent.js');

describe('sub-agent reasoning (Path C)', () => {
  beforeEach(() => {
    createAgent.mockClear();
    warn.mockClear();
  });

  it.each(['off', 'low', 'high', 'max'] as const)(
    'passes explicit %s to the sub-agent',
    async (depth) => {
      const result = await callAgentTool.invoke(
        callAgentSchema.parse({
          action: 'start_task',
          agentId: 'haiku-agent',
          query: 'Summarize this',
          reasoningEffort: depth,
        })
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const options = createAgent.mock.calls[0][0];
      expect(options.reasoningEffort).toBe(depth);
      expect(getReasoningConfig(options.modelId!, options.reasoningEffort)).toEqual(
        depth === 'off'
          ? { thinking: { type: 'disabled' } }
          : {
              thinking: { type: 'adaptive', display: 'summarized' },
              output_config: { effort: depth },
            }
      );
      expect((await subAgentTaskManager.getTask(result.taskId))?.status).toBe('completed');
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('normalizes mixed-case input from direct callers', async () => {
    await subAgentTaskManager.createTask('haiku-agent', 'Summarize this', {
      reasoningEffort: 'OFF' as ReasoningDepth,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createAgent.mock.calls[0][0].reasoningEffort).toBe('off');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and uses the model default for unknown input from direct callers', async () => {
    await subAgentTaskManager.createTask('haiku-agent', 'Summarize this', {
      reasoningEffort: 'xhigh' as ReasoningDepth,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createAgent.mock.calls[0][0].reasoningEffort).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'haiku-agent', reasoningEffort: 'xhigh' }),
      'Ignoring unknown reasoningEffort; using the model default'
    );
  });

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
