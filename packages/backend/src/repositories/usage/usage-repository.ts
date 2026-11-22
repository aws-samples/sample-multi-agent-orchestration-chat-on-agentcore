import type { UserId } from '@moca/core';
import type { MonthlyModelUsage, UsageDelta } from './types.js';

/**
 * Monthly per-model token usage. Rows are only ever increased (ADD): nothing
 * in the API surface can lower a user's usage.
 */
export interface UsageRepository {
  isConfigured(): boolean;
  /**
   * Atomically add each delta to its (user, month, model) row — once per
   * `batchId`. A retried batch (the Runtime could not tell whether the first
   * attempt landed) returns 'duplicate' and changes nothing.
   */
  addBatch(
    userId: UserId,
    month: string,
    batchId: string,
    deltas: ReadonlyMap<string, UsageDelta>
  ): Promise<'applied' | 'duplicate'>;
  /** All model rows of `month` (`YYYY-MM`) for the user. */
  getMonth(userId: UserId, month: string): Promise<MonthlyModelUsage[]>;
}
