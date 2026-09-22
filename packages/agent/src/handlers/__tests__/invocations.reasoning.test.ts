import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import type { CreateAgentOptions } from '../../runtime/agent/types.js';
import { getReasoningConfig } from '@moca/core';

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
  logger: { info: jest.fn() },
}));
jest.unstable_mockModule('../stream-handler.js', () => ({ streamAgentResponse: jest.fn() }));
jest.unstable_mockModule('../../services/session-terminator.js', () => ({
  stopOwnSession: jest.fn(),
}));

const { handleInvocation } = await import('../invocations.js');

beforeEach(() => jest.clearAllMocks());

describe('Opus 5.5 direct invocation reasoning', () => {
  it.each(['global.', 'us.', 'eu.', 'au.', 'jp.'])(
    'resolves saved off and missing effort to model defaults for %s',
    async (prefix) => {
      const modelId = `${prefix}anthropic.claude-opus-5-5`;
      for (const reasoningEffort of ['off', undefined]) {
        await handleInvocation(
          { body: { prompt: 'Hello', modelId, reasoningEffort } } as Request,
          {} as Response
        );
      }
      const savedOptions = createAgent.mock.calls[0][0];
      const defaultOptions = createAgent.mock.calls[1][0];
      expect(savedOptions).toEqual(defaultOptions);
      expect(savedOptions.modelId).toBe(modelId);
      expect(savedOptions.reasoningEffort).toBe('off');
      expect(
        getReasoningConfig(savedOptions.modelId!, savedOptions.reasoningEffort!)
      ).toBeUndefined();
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
      expect(getReasoningConfig(modelId, reasoningEffort)?.output_config.effort).toBe(
        reasoningEffort
      );
    }
  );
});
