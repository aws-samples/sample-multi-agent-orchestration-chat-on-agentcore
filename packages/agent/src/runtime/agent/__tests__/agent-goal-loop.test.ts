/**
 * Unit tests for createAgent()'s GoalLoop wiring.
 *
 * Verifies (with the SDK, GoalLoop, and createBedrockModel mocked):
 *   - a non-empty goal builds a GoalLoop with finite bounds and the resolved
 *     judge model, and appends it LAST in the plugins array;
 *   - an empty/whitespace goal builds no GoalLoop (goalLoop === undefined);
 *   - the judge model falls back to GOAL_JUDGE_MODEL_ID when the requested id is
 *     absent or unknown, and uses the requested id when known.
 *
 * ESM module mocking via jest.unstable_mockModule + dynamic import.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Captured constructor args ──────────────────────────────────────────
const agentCtorArgs: any[] = [];
const goalLoopCtorArgs: any[] = [];
const createBedrockModelCalls: any[] = [];

class FakeAgent {
  appState = { set: jest.fn() };
  constructor(config: any) {
    agentCtorArgs.push(config);
  }
}

class FakeGoalLoop {
  readonly name = 'strands:goal-loop';
  constructor(opts: any) {
    goalLoopCtorArgs.push(opts);
  }
}

// Sanitizer/hook classes only need to be `new`-able and expose a `name`.
class NamedPlugin {
  constructor(public readonly name: string) {}
}

// ── Mocks ──────────────────────────────────────────────────────────────

jest.unstable_mockModule('@strands-agents/sdk', () => ({
  Agent: FakeAgent,
  SlidingWindowConversationManager: class {
    constructor(public opts: any) {}
  },
}));

jest.unstable_mockModule('@strands-agents/sdk/vended-plugins/goal', () => ({
  GoalLoop: FakeGoalLoop,
}));

const mockIsKnownModelId = jest.fn<any>();
jest.unstable_mockModule('@moca/core', () => ({
  isKnownModelId: mockIsKnownModelId,
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  config: { GOAL_JUDGE_MODEL_ID: 'global.anthropic.claude-haiku-4-5', CONVERSATION_WINDOW_SIZE: 40 },
  GOAL_LOOP_MAX_ATTEMPTS: 3,
  GOAL_LOOP_TIMEOUT_MS: 120000,
  createBedrockModel: jest.fn<any>().mockImplementation((opts: any) => {
    createBedrockModelCalls.push(opts);
    return { __model: opts?.modelId ?? 'default' };
  }),
}));

jest.unstable_mockModule('../../../config/prompts/index.js', () => ({
  buildSystemPrompt: jest.fn<any>().mockReturnValue('SYSTEM'),
}));

jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: jest.fn<any>().mockReturnValue({ storagePath: '/tmp/ws/u/s', userId: 'u' }),
}));

jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../mcp-clients-builder.js', () => ({
  buildUserMCPClients: jest.fn<any>().mockReturnValue([]),
}));
jest.unstable_mockModule('../tools-builder.js', () => ({
  buildToolSet: jest
    .fn<any>()
    .mockResolvedValue({ tools: [], mcpClients: [], counts: { total: 0 } }),
}));
jest.unstable_mockModule('../memory-fetcher.js', () => ({
  extractMemoryParams: jest.fn<any>().mockReturnValue({}),
  fetchLongTermMemories: jest.fn<any>().mockResolvedValue({ memories: [], conditions: {} }),
}));
jest.unstable_mockModule('../session-loader.js', () => ({
  loadSessionHistory: jest.fn<any>().mockResolvedValue([]),
}));
jest.unstable_mockModule('../skills-plugin-builder.js', () => ({
  buildSkillsPlugin: jest.fn<any>().mockReturnValue(null),
}));
jest.unstable_mockModule('../stream-termination-retry-strategy.js', () => ({
  StreamTerminationRetryStrategy: class {
    retryCount = 0;
  },
}));
jest.unstable_mockModule('../../../services/session/empty-text-block-hook.js', () => ({
  EmptyTextBlockHook: class extends NamedPlugin {
    constructor() {
      super('empty-text');
    }
  },
}));
jest.unstable_mockModule('../../../services/session/empty-reasoning-block-hook.js', () => ({
  EmptyReasoningBlockHook: class extends NamedPlugin {
    constructor() {
      super('empty-reasoning');
    }
  },
}));

// ── Dynamic import (after mocks) ───────────────────────────────────────
const { createAgent } = await import('../../../agent.js');

describe('createAgent GoalLoop wiring', () => {
  beforeEach(() => {
    agentCtorArgs.length = 0;
    goalLoopCtorArgs.length = 0;
    createBedrockModelCalls.length = 0;
    mockIsKnownModelId.mockReset();
  });

  it('builds no GoalLoop when goal is absent', async () => {
    const result = await createAgent({});
    expect(result.goalLoop).toBeUndefined();
    expect(goalLoopCtorArgs).toHaveLength(0);
  });

  it('builds no GoalLoop when goal is whitespace only', async () => {
    const result = await createAgent({ goal: '   \n  ' });
    expect(result.goalLoop).toBeUndefined();
    expect(goalLoopCtorArgs).toHaveLength(0);
  });

  it('builds a GoalLoop with finite bounds and returns it', async () => {
    mockIsKnownModelId.mockReturnValue(true);
    const result = await createAgent({ goal: '  answer in 3 sentences  ' });

    expect(result.goalLoop).toBeInstanceOf(FakeGoalLoop);
    expect(goalLoopCtorArgs).toHaveLength(1);
    const opts = goalLoopCtorArgs[0];
    expect(opts.goal).toBe('answer in 3 sentences'); // trimmed
    expect(opts.maxAttempts).toBe(3);
    expect(opts.timeout).toBe(120000);
    expect(opts.judge?.model).toBeDefined();
  });

  it('appends GoalLoop LAST in the plugins array (after caller plugins)', async () => {
    mockIsKnownModelId.mockReturnValue(true);
    const callerPlugin = new NamedPlugin('caller-hook');
    await createAgent({ goal: 'be concise', plugins: [callerPlugin as any] });

    const plugins = agentCtorArgs[0].plugins;
    const last = plugins[plugins.length - 1];
    expect(last).toBeInstanceOf(FakeGoalLoop);
    // Caller plugin must precede the GoalLoop.
    expect(plugins.indexOf(callerPlugin)).toBeLessThan(plugins.length - 1);
  });

  it('uses the requested judge model when it is known', async () => {
    mockIsKnownModelId.mockReturnValue(true);
    await createAgent({ goal: 'g', goalJudgeModelId: 'global.anthropic.claude-sonnet-5' });

    expect(mockIsKnownModelId).toHaveBeenCalledWith('global.anthropic.claude-sonnet-5');
    // The judge model is built via createBedrockModel with the requested id.
    expect(
      createBedrockModelCalls.some((c) => c?.modelId === 'global.anthropic.claude-sonnet-5')
    ).toBe(true);
  });

  it('falls back to GOAL_JUDGE_MODEL_ID when the requested judge model is unknown', async () => {
    mockIsKnownModelId.mockReturnValue(false);
    await createAgent({ goal: 'g', goalJudgeModelId: 'made-up-model' });

    expect(
      createBedrockModelCalls.some((c) => c?.modelId === 'global.anthropic.claude-haiku-4-5')
    ).toBe(true);
  });

  it('falls back to GOAL_JUDGE_MODEL_ID when no judge model is requested', async () => {
    await createAgent({ goal: 'g' });

    expect(
      createBedrockModelCalls.some((c) => c?.modelId === 'global.anthropic.claude-haiku-4-5')
    ).toBe(true);
  });
});
