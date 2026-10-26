import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import type { CreateAgentOptions } from '../../runtime/agent/types.js';
import { getReasoningConfig } from '@moca/core';

const warn = jest.fn();
const createAgent = jest.fn<(options: CreateAgentOptions) => Promise<unknown>>().mockResolvedValue({
  agent: {},
  metadata: {},
  retryStrategy: {},
});

jest.unstable_mockModule('../../agent.js', () => ({ createAgent }));
jest.unstable_mockModule('../../libs/context/request-context.js', () => ({
  getCurrentContext: () => ({ requestId: 'test-request' }),
  requireUserId: () => 'test-user',
  requireIdentityId: () => 'test-identity',
}));
jest.unstable_mockModule('../../services/session/session-helper.js', () => ({
  setupSession: jest.fn(),
}));
jest.unstable_mockModule('../../services/workspace-sync-helper.js', () => ({
  initializeWorkspaceSync: jest.fn(),
  resolveSkillsPaths: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../../services/session-persistence-deps-factory.js', () => ({
  createSessionPersistenceDeps: jest.fn(),
}));
jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn },
}));
jest.unstable_mockModule('../stream-handler.js', () => ({ streamAgentResponse: jest.fn() }));
jest.unstable_mockModule('../../services/session-terminator.js', () => ({
  stopOwnSession: jest.fn(),
}));

const { handleInvocation } = await import('../invocations.js');

beforeEach(() => jest.clearAllMocks());

async function invoke(modelId: string, reasoningEffort: unknown): Promise<CreateAgentOptions> {
  createAgent.mockClear();
  await handleInvocation(
    { body: { prompt: 'Hello', modelId, reasoningEffort } } as Request,
    {} as Response
  );
  return createAgent.mock.calls[0][0];
}

describe('Opus 5.5 direct invocation reasoning', () => {
  it.each(['global.', 'us.', 'eu.', 'au.', 'jp.'])(
    'resolves saved off and missing effort to model defaults for %s',
    async (prefix) => {
      const modelId = `${prefix}anthropic.claude-opus-5-5`;
      const saved = await invoke(modelId, 'off');
      const missing = await invoke(modelId, undefined);
      expect(saved.modelId).toBe(modelId);
      expect(saved.reasoningEffort).toBe('off');
      expect(missing.reasoningEffort).toBeUndefined();
      expect(getReasoningConfig(modelId, saved.reasoningEffort)).toBeUndefined();
      expect(getReasoningConfig(modelId, missing.reasoningEffort)).toBeUndefined();
    }
  );

  it.each(['low', 'high', 'max'] as const)(
    'preserves explicit %s effort',
    async (reasoningEffort) => {
      const modelId = 'global.anthropic.claude-opus-5-5';
      await handleInvocation(
        { body: { prompt: 'Hello', modelId, reasoningEffort } } as Request,
        {} as Response
      );
      expect(createAgent.mock.calls[0][0]).toMatchObject({ modelId, reasoningEffort });
      const config = getReasoningConfig(modelId, reasoningEffort);
      expect(config && 'output_config' in config ? config.output_config.effort : undefined).toBe(
        reasoningEffort
      );
    }
  );
});

describe('reasoningEffort value semantics (Path A)', () => {
  const HAIKU = 'global.anthropic.claude-haiku-5-5';

  it.each([
    ['undefined', undefined, undefined],
    ['empty string', '', undefined],
    ['null', null, undefined],
    ['explicit off', 'off', { thinking: { type: 'disabled' } }],
    ['wrong-case OFF', 'OFF', { thinking: { type: 'disabled' } }],
  ])('Haiku 5.5 %s → %p', async (_label, value, expected) => {
    const options = await invoke(HAIKU, value);
    expect(getReasoningConfig(HAIKU, options.reasoningEffort)).toEqual(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['medium', 'xhigh', 42])(
    'Haiku 5.5 invalid %p → model default with a warning, never disabled',
    async (value) => {
      const options = await invoke(HAIKU, value);
      expect(options.reasoningEffort).toBeUndefined();
      expect(getReasoningConfig(HAIKU, options.reasoningEffort)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['global.anthropic.claude-sonnet-5-5', { thinking: { type: 'between_tools' } }],
    ['global.anthropic.claude-opus-5', undefined],
    ['global.anthropic.claude-sonnet-4-6', undefined],
  ])('explicit off on %s is unchanged', async (modelId, expected) => {
    const options = await invoke(modelId, 'off');
    expect(getReasoningConfig(modelId, options.reasoningEffort)).toEqual(expected);
  });
});
