/**
 * Pure helpers for ModelReasoningSelector — extracted so they can be unit-tested
 * under vitest (node env, no DOM). The component itself is verified via tsc +
 * manual E2E per project convention (no .tsx/testing-library tests).
 */

import { REASONING_DEPTHS, EFFORT_ORDER, isReasoningCapable, getMaxReasoningDepth } from '@moca/core';
import type { ReasoningDepth } from '@moca/core';

/**
 * Compact label for the selector trigger: drop the "Claude " brand prefix so
 * "Claude Opus 4.8" becomes "Opus 4.8". Non-Claude names are returned unchanged.
 */
export function shortModelName(name: string): string {
  return name.replace(/^Claude /, '');
}

/**
 * Depths selectable for a model, in REASONING_DEPTHS order, capped at the
 * model's `reasoningMaxEffort` (e.g. Sonnet 4.6 tops out at 'high').
 * Returns `[]` for unknown / non-reasoning models so callers can hide the
 * depth row entirely.
 */
export function availableDepthsFor(modelId: string): ReasoningDepth[] {
  if (!isReasoningCapable(modelId)) {
    return [];
  }
  const cap = getMaxReasoningDepth(modelId) ?? 'max';
  const capIndex = EFFORT_ORDER.indexOf(cap);
  return REASONING_DEPTHS.filter((d) => {
    if (d === 'off') return true;
    const i = EFFORT_ORDER.indexOf(d);
    // Require a known effort within the cap. Guard against i === -1 (a depth not
    // in EFFORT_ORDER, e.g. a future tier added to REASONING_DEPTHS but not here),
    // which would otherwise pass `-1 <= capIndex` and offer an uncapped option.
    return i >= 0 && i <= capIndex;
  });
}
