import { BedrockModel } from '@strands-agents/sdk';
import { getMaxOutputTokens } from '@moca/core';
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
 * providers (e.g. Nova) get nothing, which is the desired behaviour because
 * Nova rejects `cachePoint` in `tools[]`.
 *
 * Note: the SDK's auto strategy does NOT inject a cachePoint into the
 * `system[]` array — only into `tools[]` and `messages[]`. Long system
 * prompts therefore do not benefit from prompt caching with this approach.
 */
export function createBedrockModel(options?: BedrockModelOptions): BedrockModel {
  const modelId = options?.modelId || config.BEDROCK_MODEL_ID;
  const region = options?.region || config.BEDROCK_REGION;

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
      // Long agentic runs stream for several minutes. The Strands SDK's
      // default request timeout (120 s) is too short and intermediate idle
      // disconnects surface as `ModelError("Stream ended without completing
      // a message")` after the data plane closes the HTTP/2 stream. We
      // forward an options-bag so the SDK builds an HTTP/2 handler with our
      // tuned timeouts (issue #8).
      requestHandler: {
        requestTimeout: config.BEDROCK_STREAM_REQUEST_TIMEOUT_MS,
        sessionTimeout: config.BEDROCK_STREAM_REQUEST_TIMEOUT_MS,
      },
    },
  });
}
