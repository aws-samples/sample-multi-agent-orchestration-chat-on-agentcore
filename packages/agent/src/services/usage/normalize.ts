import { getBedrockEndpoint } from '@moca/core';

/** Per-call token usage as reported by the Strands SDK (`modelMetadataEvent.usage`). */
export interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface NormalizedUsage {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

const nonNegative = (n: number | undefined): number =>
  Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0;

/**
 * Bring usage onto one footing. Bedrock Converse reports `inputTokens`
 * WITHOUT cached tokens; the OpenAI-compatible endpoints (Mantle Responses,
 * bedrock-runtime Chat Completions) report it WITH them. Counting the OpenAI
 * shape as-is would bill cache reads twice.
 */
export function normalizeUsage(modelId: string, usage: SdkUsage): NormalizedUsage {
  const cacheRead = nonNegative(usage.cacheReadInputTokens);
  const cacheWrite = nonNegative(usage.cacheWriteInputTokens);
  const input = nonNegative(usage.inputTokens);
  const includesCache = getBedrockEndpoint(modelId) !== undefined;
  return {
    uncachedInputTokens: includesCache ? Math.max(0, input - cacheRead - cacheWrite) : input,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: nonNegative(usage.outputTokens),
  };
}

/** Input as counted against the limit: every prompt token, cached or not. */
export function totalInput(u: NormalizedUsage): number {
  return u.uncachedInputTokens + u.cacheReadInputTokens + u.cacheWriteInputTokens;
}
