/**
 * streamAgentResponse — GoalLoop retry boundary handling.
 *
 * On a goal turn the agent re-runs failed attempts inside one HTTP stream.
 * The server marks each retry boundary with `afterInvocationEvent.willRetry`
 * (the judge feedback itself never crosses the wire). The client must surface
 * that boundary via the `onGoalRetry` callback so the store can reset the
 * in-progress bubble — otherwise failed attempts concatenate live and the
 * rendered content silently changes after a reload (history keeps only the
 * final attempt).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentClient } from '../client/agent-client';
import { streamAgentResponse } from '../agent';

vi.mock('../client/agent-client', () => ({
  agentClient: { invoke: vi.fn() },
}));

/** Build a Response-like object streaming the given NDJSON lines. */
function ndjsonResponse(lines: object[]): unknown {
  const encoder = new TextEncoder();
  const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  };
}

describe('streamAgentResponse GoalLoop retry boundary', () => {
  beforeEach(() => {
    vi.mocked(agentClient.invoke).mockReset();
  });

  it('fires onGoalRetry when afterInvocationEvent carries willRetry', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      ndjsonResponse([
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'attempt 1' } },
        { type: 'afterInvocationEvent', willRetry: true },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'final' } },
        { type: 'afterInvocationEvent' },
        { type: 'serverCompletionEvent', metadata: {} },
      ]) as never
    );

    const onGoalRetry = vi.fn();
    const deltas: string[] = [];
    await streamAgentResponse('prompt', undefined, {
      onGoalRetry,
      onTextDelta: (t) => deltas.push(t),
      onComplete: () => {},
    });

    // Exactly one retry boundary — the terminal afterInvocationEvent (no
    // willRetry) must NOT fire it.
    expect(onGoalRetry).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['attempt 1', 'final']);
  });

  it('does not fire onGoalRetry on a non-goal turn (plain afterInvocationEvent)', async () => {
    vi.mocked(agentClient.invoke).mockResolvedValue(
      ndjsonResponse([
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'answer' } },
        { type: 'afterInvocationEvent' },
        { type: 'serverCompletionEvent', metadata: {} },
      ]) as never
    );

    const onGoalRetry = vi.fn();
    await streamAgentResponse('prompt', undefined, { onGoalRetry, onComplete: () => {} });

    expect(onGoalRetry).not.toHaveBeenCalled();
  });
});
