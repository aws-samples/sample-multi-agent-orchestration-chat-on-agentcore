import { modelUsageKey, parseAllowedModelIds } from '@moca/core';

/** Whether `modelId` is one of the deployment's models (cross-region prefix-insensitive). */
export function isAllowedModelId(modelId: string, configured: string | undefined): boolean {
  const key = modelUsageKey(modelId);
  return parseAllowedModelIds(configured).some((id) => modelUsageKey(id) === key);
}
