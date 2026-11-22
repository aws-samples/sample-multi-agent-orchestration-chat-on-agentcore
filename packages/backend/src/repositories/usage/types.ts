/** Token counts added to one (user, month, model) row by a batch of records. */
export interface UsageDelta {
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly calls: number;
}

/** One (user, month, model) row. `inputTokens` = uncached + cache read + cache write. */
export interface MonthlyModelUsage {
  readonly modelKey: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly calls: number;
}
