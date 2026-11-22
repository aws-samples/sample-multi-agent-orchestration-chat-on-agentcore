import { exceededDimension, modelUsageKey, type TokenLimitEventDetail } from '@moca/core';
import type { RequestContext } from '../../libs/context/request-context.js';
import { getSummary } from './usage-client.js';
import { unacknowledgedFor } from './usage-recorder.js';

/**
 * The exceeded limit for `modelId`, or undefined when the caller may proceed.
 * Fails open: a Backend that cannot be reached never blocks a turn here.
 */
export async function checkTokenLimit(
  ctx: RequestContext | undefined,
  modelId: string
): Promise<TokenLimitEventDetail | undefined> {
  const result = await getSummary(ctx);
  if (result.kind !== 'ok' || !result.value.enabled) return undefined;
  const modelKey = modelUsageKey(modelId);
  const reported = result.value.models.find((m) => m.modelKey === modelKey);
  if (!reported) return undefined;
  // Usage this process has not reported yet (a turn that just ended) counts too.
  const pending = unacknowledgedFor(ctx?.userId, modelKey);
  const usage = {
    input: { ...reported.input, used: reported.input.used + pending.input },
    output: { ...reported.output, used: reported.output.used + pending.output },
  };
  const dimension = exceededDimension(usage);
  if (!dimension) return undefined;
  return {
    modelKey,
    dimension,
    used: usage[dimension].used,
    limit: usage[dimension].limit ?? 0,
    resetsAt: result.value.period.resetsAt,
  };
}
