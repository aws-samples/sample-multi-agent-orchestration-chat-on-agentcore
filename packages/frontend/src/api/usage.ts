/**
 * Usage API Client — the signed-in user's monthly token usage and limits.
 */

import { modelUsageKey, type ModelUsage, type UsageSummary } from '@moca/core';
import { backendClient } from './client/backend-client';

type RawModelUsage = Omit<ModelUsage, 'modelKey'> & { modelKey?: string; modelId?: string };
type UsageResponse = Omit<UsageSummary, 'models'> & {
  models?: RawModelUsage[];
  metadata?: unknown;
};

/** GET /usage/me. */
export async function getMyUsage(): Promise<UsageSummary> {
  const data = await backendClient.get<UsageResponse>('/usage/me');
  return {
    enabled: data.enabled === true,
    period: data.period,
    groups: data.groups ?? [],
    // Normalize to the metering key: accept a prefixed modelId as well.
    models: (data.models ?? []).map(({ modelId, modelKey, ...rest }) => ({
      ...rest,
      modelKey: modelKey ?? modelUsageKey(modelId ?? ''),
    })),
  };
}
