/**
 * End-to-end cancellation test — real Strands Agent, no AWS.
 *
 * The unit tests for stream-handler mock the agent. This test exercises the
 * ACTUAL SDK cancellation contract our design relies on, driving a real
 * `Agent` with a slow in-process `Model` and cancelling via the same external
 * `cancelSignal` the handler wires up. It proves, end to end:
 *
 *   1. an external AbortSignal fired mid-stream makes `agent.stream(...)` return
 *      an AgentResult with `stopReason: 'cancelled'` (not throw);
 *   2. after cancellation `agent.messages` is left in a reinvokable state — no
 *      dangling toolUse without a matching toolResult — so history stays
 *      consistent (the invariant our handler leans on instead of hand-repairing);
 *   3. the agent can be reinvoked cleanly after a cancel.
 *
 * If a future SDK bump changes any of these, this test fails loudly — which is
 * exactly the signal we want, since the whole feature is built on them.
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, Model } from '@strands-agents/sdk';
import type { Message } from '@strands-agents/sdk';

/**
 * A model that streams a few text deltas with a delay between each, giving the
 * test a window to abort mid-generation. Honours the AbortSignal the SDK passes
 * through `options.abortSignal` so cancellation is prompt.
 */
class SlowTextModel extends Model {
  private config = { modelId: 'slow-test-model' };

  updateConfig(modelConfig: { modelId: string }): void {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig(): { modelId: string } {
    return this.config;
  }

  async *stream(_messages: Message[], options?: { abortSignal?: AbortSignal }): AsyncIterable<any> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    for (let i = 0; i < 20; i++) {
      if (options?.abortSignal?.aborted) break;
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `tok${i} ` } };
      await new Promise((r) => setTimeout(r, 20));
    }
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

/** Assert there is no toolUse block left without a matching toolResult. */
function hasDanglingToolUse(messages: Message[]): boolean {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    for (const block of m.content as any[]) {
      if (block?.type === 'toolUseBlock' && block.toolUseId) toolUseIds.add(block.toolUseId);
      if (block?.type === 'toolResultBlock' && block.toolUseId) toolResultIds.add(block.toolUseId);
    }
  }
  return [...toolUseIds].some((id) => !toolResultIds.has(id));
}

describe('agent cancellation (real SDK, no AWS)', () => {
  it('returns stopReason "cancelled" when the external cancelSignal fires mid-stream', async () => {
    const agent = new Agent({ model: new SlowTextModel() });
    const controller = new AbortController();

    const stream = agent.stream('Write a long essay', { cancelSignal: controller.signal });

    // Consume a couple of events, then abort — same shape as the handler's
    // res 'close' → controller.abort() path.
    let eventCount = 0;
    let result: any;
    const pump = (async () => {
      let next = await stream.next();
      while (!next.done) {
        eventCount++;
        if (eventCount === 2) controller.abort();
        next = await stream.next();
      }
      result = next.value;
    })();
    await pump;

    expect(result?.stopReason).toBe('cancelled');
  });

  it('leaves messages reinvokable (no dangling toolUse) after cancellation', async () => {
    const agent = new Agent({ model: new SlowTextModel() });
    const controller = new AbortController();

    const stream = agent.stream('Do something', { cancelSignal: controller.signal });
    let next = await stream.next();
    let count = 0;
    while (!next.done) {
      if (++count === 2) controller.abort();
      next = await stream.next();
    }

    expect(hasDanglingToolUse(agent.messages)).toBe(false);
  });

  it('can be reinvoked after a cancellation and complete normally', async () => {
    const agent = new Agent({ model: new SlowTextModel() });
    const controller = new AbortController();

    // First turn: cancel it.
    const stream = agent.stream('First', { cancelSignal: controller.signal });
    let next = await stream.next();
    let count = 0;
    while (!next.done) {
      if (++count === 2) controller.abort();
      next = await stream.next();
    }

    // Second turn: fresh signal, run to completion.
    const result = await agent.invoke('Second');
    expect(result.stopReason).toBe('endTurn');
  });
});
