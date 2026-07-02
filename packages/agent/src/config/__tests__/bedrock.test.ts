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
// Capture the options passed to the (mocked) OpenAIModel constructor.
const openaiConstructorCalls: Array<Record<string, unknown>> = [];

class MockBedrockModel {
  constructor(opts: Record<string, unknown>) {
    constructorCalls.push(opts);
  }
}
class MockOpenAIModel {
  constructor(opts: Record<string, unknown>) {
    openaiConstructorCalls.push(opts);
  }
}

jest.unstable_mockModule('@strands-agents/sdk', () => ({
  BedrockModel: MockBedrockModel,
}));

jest.unstable_mockModule('@strands-agents/sdk/models/openai', () => ({
  OpenAIModel: MockOpenAIModel,
}));

// The token provider is a factory returning an async () => token function.
// Capture the config it was created with so we can assert region wiring.
const tokenProviderConfigs: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@aws/bedrock-token-generator', () => ({
  getTokenProvider: (cfg: Record<string, unknown>) => {
    tokenProviderConfigs.push(cfg);
    return async () => 'mock-bearer-token';
  },
}));

jest.unstable_mockModule('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }),
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
  openaiConstructorCalls.length = 0;
  tokenProviderConfigs.length = 0;
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

describe('createBedrockModel OpenAI routing — gpt-oss (bedrock-openai endpoint)', () => {
  it('builds an OpenAIModel (not a BedrockModel) for a gpt-oss id', () => {
    const model = createBedrockModel({ modelId: 'openai.gpt-oss-120b-1:0' });
    expect(model).toBeInstanceOf(MockOpenAIModel);
    expect(openaiConstructorCalls).toHaveLength(1);
    // The Converse-API BedrockModel must not be constructed for this path.
    expect(constructorCalls).toHaveLength(0);
  });

  it('uses the Chat Completions API mode (gpt-oss rejects the Responses API)', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-120b-1:0' });
    expect(openaiConstructorCalls[0].api).toBe('chat');
  });

  it('points the client at the bedrock-runtime OpenAI base URL for the deploy region', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-120b-1:0' });
    // gpt-oss has no region pin, so it is invoked in BEDROCK_REGION
    // (ap-northeast-1 in this mocked config); base URL and token provider
    // region must both follow that.
    const clientConfig = openaiConstructorCalls[0].clientConfig as Record<string, unknown>;
    expect(clientConfig.baseURL).toBe(
      'https://bedrock-runtime.ap-northeast-1.amazonaws.com/openai/v1'
    );
    expect(tokenProviderConfigs[0].region).toBe('ap-northeast-1');
  });

  it('passes a bearer-token apiKey function to the OpenAI client', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-20b-1:0' });
    expect(typeof openaiConstructorCalls[0].apiKey).toBe('function');
  });

  it('derives maxTokens from the model registry for gpt-oss models', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-120b-1:0' });
    expect(openaiConstructorCalls[0].maxTokens).toBe(131072);
  });

  it('does not pass prompt caching or Anthropic-native thinking to OpenAI models', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-120b-1:0', reasoningEffort: 'high' });
    expect(openaiConstructorCalls[0].cacheConfig).toBeUndefined();
    expect(openaiConstructorCalls[0].additionalRequestFields).toBeUndefined();
  });

  it('lets an explicit options.region select the bedrock-runtime endpoint region', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-20b-1:0', region: 'us-west-2' });
    const clientConfig = openaiConstructorCalls[0].clientConfig as Record<string, unknown>;
    expect(clientConfig.baseURL).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1');
    expect(tokenProviderConfigs[0].region).toBe('us-west-2');
  });

  it('does not pass reasoning params to gpt-oss (Chat Completions has no reasoning phase)', () => {
    createBedrockModel({ modelId: 'openai.gpt-oss-120b-1:0' });
    expect(openaiConstructorCalls[0].params).toBeUndefined();
  });
});

describe('createBedrockModel OpenAI routing — gpt-5.x (mantle endpoint)', () => {
  it('builds an OpenAIModel for a gpt-5.x id', () => {
    const model = createBedrockModel({ modelId: 'openai.gpt-5.5' });
    expect(model).toBeInstanceOf(MockOpenAIModel);
    expect(constructorCalls).toHaveLength(0);
  });

  it('uses the Responses API mode (gpt-5.x rejects Chat Completions)', () => {
    createBedrockModel({ modelId: 'openai.gpt-5.5' });
    expect(openaiConstructorCalls[0].api).toBe('responses');
  });

  it('points the client at the Mantle base URL pinned to us-east-1', () => {
    createBedrockModel({ modelId: 'openai.gpt-5.5' });
    // gpt-5.5 is registry-pinned to us-east-1 (only region hosting it), which
    // overrides the ap-northeast-1 deploy region in this mocked config.
    const clientConfig = openaiConstructorCalls[0].clientConfig as Record<string, unknown>;
    expect(clientConfig.baseURL).toBe('https://bedrock-mantle.us-east-1.api.aws/openai/v1');
    expect(tokenProviderConfigs[0].region).toBe('us-east-1');
  });

  it('derives maxTokens from the registry for gpt-5.x', () => {
    createBedrockModel({ modelId: 'openai.gpt-5.4' });
    expect(openaiConstructorCalls[0].maxTokens).toBe(128000);
  });

  it('disables reasoning (effort:none) for gpt-5.x to prevent truncated tool-call JSON', () => {
    // gpt-5.x reasoning models truncate tool-call arguments when reasoning is
    // on, crashing the turn with "Unterminated string in JSON". reasoning.effort
    // 'none' is passed via params (Responses API) to prevent that.
    createBedrockModel({ modelId: 'openai.gpt-5.5' });
    expect(openaiConstructorCalls[0].params).toEqual({ reasoning: { effort: 'none' } });
  });
});
