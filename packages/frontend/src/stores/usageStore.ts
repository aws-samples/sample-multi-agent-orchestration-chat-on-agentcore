/**
 * Monthly token usage Zustand store (GET /usage/me).
 *
 * Fetched after sign-in, shortly after each turn completes, and when the
 * settings page opens. A failed fetch leaves `summary` null: the model
 * selector then shows no badges rather than stale or guessed ones.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { modelUsageKey, type ModelUsage, type UsageStatus, type UsageSummary } from '@moca/core';
import * as usageApi from '../api/usage';
import { extractErrorMessage } from '../utils/store-helpers';
import { logger } from '../utils/logger';

/** Turn completions are bursty (sub-agents, retries); one refetch covers them. */
export const USAGE_REFRESH_DEBOUNCE_MS = 2000;

interface UsageState {
  summary: UsageSummary | null;
  isLoading: boolean;
  error: string | null;
}

interface UsageActions {
  fetchUsage: () => Promise<void>;
  /** Debounced fetchUsage, for turn completion. */
  scheduleRefresh: () => void;
  /** Status of a model id (any cross-region prefix); undefined when unknown or disabled. */
  statusFor: (modelId: string) => UsageStatus | undefined;
  usageFor: (modelId: string) => ModelUsage | undefined;
  reset: () => void;
}

type UsageStore = UsageState & UsageActions;

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// Drops responses of fetches superseded by a newer one or by reset().
let fetchGeneration = 0;

export const useUsageStore = create<UsageStore>()(
  devtools(
    (set, get) => ({
      summary: null,
      isLoading: false,
      error: null,

      fetchUsage: async () => {
        const generation = ++fetchGeneration;
        set({ isLoading: true });
        try {
          const summary = await usageApi.getMyUsage();
          if (generation !== fetchGeneration) return;
          set({ summary, isLoading: false, error: null });
        } catch (error) {
          if (generation !== fetchGeneration) return;
          logger.warn('Failed to fetch usage:', error);
          set({
            summary: null,
            isLoading: false,
            error: extractErrorMessage(error, 'Failed to fetch usage'),
          });
        }
      },

      scheduleRefresh: () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void get().fetchUsage();
        }, USAGE_REFRESH_DEBOUNCE_MS);
      },

      usageFor: (modelId: string) => {
        const { summary } = get();
        if (!summary?.enabled) return undefined;
        const key = modelUsageKey(modelId);
        return summary.models.find((m) => m.modelKey === key);
      },

      statusFor: (modelId: string) => get().usageFor(modelId)?.status,

      reset: () => {
        fetchGeneration++;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = undefined;
        set({ summary: null, isLoading: false, error: null });
      },
    }),
    { name: 'usage-store' }
  )
);
