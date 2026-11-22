/**
 * Monthly token-limit state per model id, for ModelReasoningSelector.
 * Returns undefined for every model when usage is unknown or limits are off.
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUsageStore } from '../stores/usageStore';
import { modelUsageIndicator, type ModelUsageIndicator } from '../utils/usageFormat';

export function useModelUsageIndicators(): (modelId: string) => ModelUsageIndicator | undefined {
  const { t } = useTranslation();
  const summary = useUsageStore((s) => s.summary);
  return useCallback((modelId: string) => modelUsageIndicator(summary, modelId, t), [summary, t]);
}
