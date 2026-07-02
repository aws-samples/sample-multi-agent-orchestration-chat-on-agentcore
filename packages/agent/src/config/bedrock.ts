import { BedrockModel, type JSONValue, type Model } from '@strands-agents/sdk';
import {
  getMaxOutputTokens,
  getModelRegion,
  getReasoningConfig,
  getBedrockEndpoint,
} from '@moca/core';
import type { ReasoningDepth } from '@moca/core';
import { config } from './index.js';
import { logger } from '../libs/logger/index.js';
import { createBedrockOpenAiModel } from './bedrock-openai-model.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BedrockModelOptions {
  modelId?: string;
  region?: string;
  /**
   * Explicit maxTokens override.
   * When omitted, getMaxOutputTokens() from @moca/core derives the value from the model ID.
   */
  maxTokens?: number;
  /**
   * Reasoning (extended thinking) depth selected for this request.
   * Resolved against the model registry into a `thinking` request field; a
   * non-capable model or `off` (or omitted) yields no thinking field.
   */
  reasoningEffort?: ReasoningDepth;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a Bedrock model with prompt caching auto-managed by the SDK.
 *
 * Forwards `cacheConfig: { strategy: 'auto' }` when `ENABLE_PROMPT_CACHING`
 * is true. The SDK's `'auto'` strategy resolves to its internal Anthropic
 * pattern list (`anthropic` / `claude` substring match) — Anthropic models
 * get cache points injected into `tools[]` and the last user message; other
 * providers (e.g. Nova, Qwen3) get nothing, which is the desired behaviour:
 * Bedrock prompt caching is not supported for those families and they reject
 * (or ignore) `cachePoint` blocks, so the `auto` strategy safely no-ops.
 *
 * Note: the SDK's auto strategy does NOT inject a cachePoint into the
 * `system[]` array — only into `tools[]` and `messages[]`. Long system
 * prompts therefore do not benefit from prompt caching with this approach.
 *
 * Models with a non-Converse endpoint (gpt-oss via bedrock-openai / gpt-5.x via
 * mantle) route to a Strands `OpenAIModel` instead — see
 * {@link createBedrockOpenAiModel}. Both share the `Model` base class, so the
 * returned value is passed to `new Agent({ model })` unchanged.
 */
export function createBedrockModel(options?: BedrockModelOptions): Model {
  const modelId = options?.modelId || config.BEDROCK_MODEL_ID;
  // Region resolution order:
  //   1. explicit options.region (caller override)
  //   2. the model's own region pin from @moca/core (for In-Region-only models
  //      not yet rolled out to the deployment region, e.g. qwen.qwen3-coder-next)
  //   3. the deployment's BEDROCK_REGION (default for almost every model)
  const region = options?.region || getModelRegion(modelId) || config.BEDROCK_REGION;

  // Some models are invoked over an OpenAI-compatible Bedrock endpoint, not
  // Converse. Route them to the OpenAIModel factory before any Converse-only
  // setup (prompt caching, Anthropic-native thinking) — neither applies. The
  // endpoint (gpt-oss bedrock-openai vs gpt-5.x mantle) comes from the registry.
  const endpoint = getBedrockEndpoint(modelId);
  if (endpoint) {
    return createBedrockOpenAiModel({
      modelId,
      region,
      endpoint,
      maxTokens: options?.maxTokens,
    });
  }

  // Resolve the reasoning depth into a Bedrock `thinking` request field. Returns
  // undefined for off / non-capable models, in which case no thinking field is
  // sent. The SDK strips `thinking` automatically when toolChoice forces a tool
  // (Bedrock disallows thinking + forced tool_use), so this is safe with tools.
  const reasoningConfig = getReasoningConfig(modelId, options?.reasoningEffort ?? 'off');

  logger.debug(
    {
      modelId,
      region,
      promptCachingEnabled: config.ENABLE_PROMPT_CACHING,
      reasoningEffort: options?.reasoningEffort ?? 'off',
      // The effort actually sent (may be clamped below the requested depth, e.g.
      // Sonnet 4.6 'max' → 'high'). undefined when no thinking field is sent.
      reasoningEffortSent: reasoningConfig?.output_config.effort,
    },
    'Creating BedrockModel:'
  );

  return new BedrockModel({
    region,
    modelId,
    // Prefer an explicit override; fall back to the per-model limit from @moca/core.
    maxTokens: options?.maxTokens ?? getMaxOutputTokens(modelId),
    ...(config.ENABLE_PROMPT_CACHING ? { cacheConfig: { strategy: 'auto' as const } } : {}),
    // Extended thinking is configured at the model layer via the Bedrock
    // `additionalModelRequestFields`. Only attach when a budget resolved. Cast to
    // the SDK's JSONValue: ReasoningRequestConfig is a readonly interface without
    // an index signature, which JSONValue's `{ [key: string]: JSONValue }` wants.
    ...(reasoningConfig
      ? { additionalRequestFields: reasoningConfig as unknown as JSONValue }
      : {}),
    clientConfig: {
      retryMode: 'adaptive',
      maxAttempts: 5,
    },
  });
}
