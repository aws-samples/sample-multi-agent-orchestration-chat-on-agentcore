import { BedrockModel } from '@strands-agents/sdk';
import { getMaxOutputTokens, getModelRegion } from '@moca/core';
import { config } from './index.js';
import { logger } from '../libs/logger/index.js';

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
 */
export function createBedrockModel(options?: BedrockModelOptions): BedrockModel {
  const modelId = options?.modelId || config.BEDROCK_MODEL_ID;
  // Region resolution order:
  //   1. explicit options.region (caller override)
  //   2. the model's own region pin from @moca/core (for In-Region-only models
  //      not yet rolled out to the deployment region, e.g. qwen.qwen3-coder-next)
  //   3. the deployment's BEDROCK_REGION (default for almost every model)
  const region = options?.region || getModelRegion(modelId) || config.BEDROCK_REGION;

  logger.debug(
    {
      modelId,
      region,
      promptCachingEnabled: config.ENABLE_PROMPT_CACHING,
    },
    'Creating BedrockModel:'
  );

  return new BedrockModel({
    region,
    modelId,
    // Prefer an explicit override; fall back to the per-model limit from @moca/core.
    maxTokens: options?.maxTokens ?? getMaxOutputTokens(modelId),
    ...(config.ENABLE_PROMPT_CACHING ? { cacheConfig: { strategy: 'auto' as const } } : {}),
    clientConfig: {
      retryMode: 'adaptive',
      maxAttempts: 5,
    },
  });
}
