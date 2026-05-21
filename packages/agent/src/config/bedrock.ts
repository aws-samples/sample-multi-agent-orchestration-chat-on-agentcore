import { BedrockModel } from '@strands-agents/sdk';
import { getMaxOutputTokens, getPromptCachingSupport } from '@moca/core';
import { config } from './index.js';
import { logger } from '../libs/logger/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Public factory options for `createBedrockModel`.
 *
 * Note: `@strands-agents/sdk@>=1.0` removed the per-axis `cachePrompt` /
 * `cacheTools` flags from `BedrockModelOptions` in favour of a single
 * `cacheConfig: { strategy: 'auto' | 'anthropic' }` knob. This codebase
 * deliberately keeps prompt-cache placement under explicit control via
 * `services/session/cache-point-appender.ts`, which inserts
 * `CachePointBlock` directly into `messages`. We therefore intentionally
 * do NOT pass `cacheConfig` to `BedrockModel`: doing so would cause the
 * SDK's `'auto'` strategy to inject *additional* cache points on top of
 * ours and conflict with the project's per-message budget logic.
 *
 * `cachePrompt` / `cacheTools` are kept on this options shape only as
 * historical metadata for callers (and existing integration tests) that
 * still pass them — they are honoured for the LOG line and gating logic
 * below, but never forwarded to `BedrockModel`.
 */
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
 * - Caching is gated by the global `ENABLE_PROMPT_CACHING` config flag and
 *   the per-model capability table from `@moca/core`.
 * - Cache *points* themselves are injected by `CachePointAppender` at the
 *   message level (see `services/session/cache-point-appender.ts`); this
 *   factory only logs which axes are enabled for diagnostics. The SDK's
 *   `cacheConfig.strategy` is intentionally NOT used to avoid double
 *   cache-point insertion.
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
    // Prefer an explicit override; fall back to the per-model limit from @moca/core.
    maxTokens: options?.maxTokens ?? getMaxOutputTokens(modelId),
    clientConfig: {
      retryMode: 'adaptive',
      maxAttempts: 5,
    },
  });
}
