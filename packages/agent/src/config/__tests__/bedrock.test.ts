/**
 * createBedrockModel() unit tests — region & maxTokens resolution.
 *
 * These verify the region-resolution order without touching AWS:
 *   1. explicit options.region
 *   2. the model's region pin from @moca/core (getModelRegion)
 *   3. config.BEDROCK_REGION (deployment default)
 *
 * The Strands SDK BedrockModel constructor is mocked to capture its options,
 * and ./index.js is mocked to supply a deterministic config.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Capture the options passed to the (mocked) BedrockModel constructor.
const constructorCalls: Array<Record<string, unknown>> = [];

jest.unstable_mockModule('@strands-agents/sdk', () => ({
  BedrockModel: class {
    constructor(opts: Record<string, unknown>) {
      constructorCalls.push(opts);
    }
  },
}));

jest.unstable_mockModule('../index.js', () => ({
  config: {
    BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-6',
    BEDROCK_REGION: 'ap-northeast-1',
    ENABLE_PROMPT_CACHING: false,
  },
}));

jest.unstable_mockModule('../../libs/logger/index.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { createBedrockModel } = await import('../bedrock.js');

beforeEach(() => {
  constructorCalls.length = 0;
});

describe('createBedrockModel region resolution', () => {
  it('uses the deployment BEDROCK_REGION for a model with no region pin', () => {
    createBedrockModel({ modelId: 'global.anthropic.claude-sonnet-4-6' });
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0].region).toBe('ap-northeast-1');
  });

  it('uses the model region pin when set, overriding BEDROCK_REGION', () => {
    // qwen.qwen3-coder-next is pinned to us-east-1 in @moca/core because it is
    // not rolled out to the default deployment region (ap-northeast-1).
    createBedrockModel({ modelId: 'qwen.qwen3-coder-next' });
    expect(constructorCalls[0].region).toBe('us-east-1');
    expect(constructorCalls[0].modelId).toBe('qwen.qwen3-coder-next');
  });

  it('lets an explicit options.region win over the model pin', () => {
    createBedrockModel({ modelId: 'qwen.qwen3-coder-next', region: 'us-west-2' });
    expect(constructorCalls[0].region).toBe('us-west-2');
  });

  it('derives maxTokens from the model registry', () => {
    createBedrockModel({ modelId: 'qwen.qwen3-coder-next' });
    expect(constructorCalls[0].maxTokens).toBe(16384);
  });
});

describe('createBedrockModel reasoning (extended thinking)', () => {
  it('injects adaptive thinking + effort for a capable model + non-off depth', () => {
    createBedrockModel({ modelId: 'global.anthropic.claude-opus-4-8', reasoningEffort: 'high' });
    expect(constructorCalls[0].additionalRequestFields).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
  });

  it('omits additionalRequestFields when depth is off', () => {
    createBedrockModel({ modelId: 'global.anthropic.claude-opus-4-8', reasoningEffort: 'off' });
    expect(constructorCalls[0].additionalRequestFields).toBeUndefined();
  });

  it('omits additionalRequestFields when reasoningEffort is not provided', () => {
    createBedrockModel({ modelId: 'global.anthropic.claude-opus-4-8' });
    expect(constructorCalls[0].additionalRequestFields).toBeUndefined();
  });

  it('omits additionalRequestFields for a non-capable model even with a depth', () => {
    createBedrockModel({ modelId: 'qwen.qwen3-coder-next', reasoningEffort: 'max' });
    expect(constructorCalls[0].additionalRequestFields).toBeUndefined();
  });
});
