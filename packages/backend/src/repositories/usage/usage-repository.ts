import type { UserId } from '@moca/core';
import type { MonthlyModelUsage, UsageDelta } from './types.js';

/**
 * Monthly per-model token usage. Rows are only ever increased (ADD): nothing
 * in the API surface can lower a user's usage.
 */
export interface UsageRepository {
  isConfigured(): boolean;
  /** Atomically add `delta` to the (user, month, model) row, creating it if absent. */
  addUsage(userId: UserId, month: string, modelKey: string, delta: UsageDelta): Promise<void>;
  /** All model rows of `month` (`YYYY-MM`) for the user. */
  getMonth(userId: UserId, month: string): Promise<MonthlyModelUsage[]>;
}
