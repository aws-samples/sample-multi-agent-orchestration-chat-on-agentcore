import { BedrockModel } from '@strands-agents/sdk';
import { getMaxOutputTokens, getPromptCachingSupport } from '@moca/core';
import { config } from './index.js';
import { logger } from '../libs/logger/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BedrockModelOptions {
  modelId?: string;
  region?: string;
  cachePrompt?: 'default' | 'ephemeral';
  cacheTools?: 'default' | 'ephemeral';
  /**
   * Explicit maxTokens override.
   * When omitted, getMaxOutputTokens() from @moca/core derives the value from the model ID.
   */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Pure query helpers (delegated to @moca/core — Single Source of Truth)
// ---------------------------------------------------------------------------

/** Does this model support prompt caching (system or messages)? */
export function supportsPromptCaching(modelId: string): boolean {
  const s = getPromptCachingSupport(modelId);
  return s.system || s.messages;
}

/** Does this model support tool caching? */
export function supportsToolCaching(modelId: string): boolean {
  return getPromptCachingSupport(modelId).tools;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a Bedrock model with cache options resolved based on model capability.
 *
 * - cachePrompt is enabled for models that support system/messages caching
 * - cacheTools is enabled only for models that support tool caching (Claude)
 * - Both are gated by the global ENABLE_PROMPT_CACHING config flag
 */
export function createBedrockModel(options?: BedrockModelOptions): BedrockModel {
  const modelId = options?.modelId || config.BEDROCK_MODEL_ID;
  const region = options?.region || config.BEDROCK_REGION;

  const cachingSupport = getPromptCachingSupport(modelId);

  const cachePrompt =
    config.ENABLE_PROMPT_CACHING && cachingSupport.system
      ? options?.cachePrompt || config.CACHE_TYPE
      : undefined;

  const cacheTools =
    config.ENABLE_PROMPT_CACHING && cachingSupport.tools
      ? options?.cacheTools || config.CACHE_TYPE
      : undefined;

  logger.debug(
    {
      modelId,
      region,
      cachePrompt,
      cacheTools,
      cachingSupport,
    },
    'Creating BedrockModel:'
  );

  return new BedrockModel({
    region,
    modelId,
    cachePrompt,
    cacheTools,
    // Prefer an explicit override; fall back to the per-model limit from @moca/core.
    maxTokens: options?.maxTokens ?? getMaxOutputTokens(modelId),
    clientConfig: {
      retryMode: 'adaptive',
      maxAttempts: 5,
    },
  });
}
