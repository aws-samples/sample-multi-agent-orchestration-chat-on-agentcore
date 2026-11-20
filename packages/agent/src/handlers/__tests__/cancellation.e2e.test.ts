/**
 * The SDK cancellation contract the stop feature relies on, against a real
 * Strands Agent with an in-process model (no AWS). If an SDK bump changes any
 * of this, the feature silently breaks, so pin it here.
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, Model, tool } from '@strands-agents/sdk';
import type { Message } from '@strands-agents/sdk';
import { z } from 'zod';

type ModelEvent = Record<string, unknown>;

/** Streams text slowly, leaving a window to stop mid-generation. */
class SlowTextModel extends Model {
  private config = { modelId: 'slow-test-model' };
  updateConfig(modelConfig: { modelId: string }): void {
    this.config = { ...this.config, ...modelConfig };
  }
  getConfig(): { modelId: string } {
    return this.config;
  }
  async *stream(): AsyncIterable<any> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    for (let i = 0; i < 20; i++) {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `tok${i} ` } };
      await new Promise((r) => setTimeout(r, 20));
    }
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

/** Calls the `slow` tool on the first turn, answers in text afterwards. */
class ToolCallingModel extends Model {
  private config = { modelId: 'tool-test-model' };
  updateConfig(modelConfig: { modelId: string }): void {
    this.config = { ...this.config, ...modelConfig };
  }
  getConfig(): { modelId: string } {
    return this.config;
  }
  async *stream(messages: Message[]): AsyncIterable<any> {
    const last = messages[messages.length - 1];
    const answeredTool = (last?.content as any[]).some((b) => b?.type === 'toolResultBlock');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (answeredTool || messages.length > 2) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      return;
    }
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: 'slow', toolUseId: 'tu-1' },
    } satisfies ModelEvent;
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: '{}' },
    } satisfies ModelEvent;
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
}

function hasDanglingToolUse(messages: Message[]): boolean {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    for (const block of m.content as any[]) {
      if (block?.type === 'toolUseBlock') uses.add(block.toolUseId);
      if (block?.type === 'toolResultBlock') results.add(block.toolUseId);
    }
  }
  return [...uses].some((id) => !results.has(id));
}

async function drain(stream: AsyncGenerator<unknown, any>, onEvent?: (n: number) => void) {
  let n = 0;
  let next = await stream.next();
  while (!next.done) {
    onEvent?.(++n);
    next = await stream.next();
  }
  return next.value;
}

describe('agent cancellation (real SDK, no AWS)', () => {
  it('ends with stopReason "cancelled" when the signal fires mid-stream', async () => {
    const agent = new Agent({ model: new SlowTextModel(), printer: false });
    const controller = new AbortController();
    const result = await drain(agent.stream('essay', { cancelSignal: controller.signal }), (n) => {
      if (n === 3) controller.abort();
    });
    expect(result.stopReason).toBe('cancelled');
  });

  it('cancels at the first checkpoint when the stop arrived before the turn began', async () => {
    const agent = new Agent({ model: new SlowTextModel(), printer: false });
    const controller = new AbortController();
    controller.abort();
    const result = await drain(agent.stream('essay', { cancelSignal: controller.signal }));
    expect(result.stopReason).toBe('cancelled');
  });

  it('lets a running tool finish, then stops without calling the model again', async () => {
    const controller = new AbortController();
    let toolFinished = false;
    const slow = tool({
      name: 'slow',
      description: 'slow tool',
      inputSchema: z.object({}),
      callback: async () => {
        controller.abort(); // the stop lands while the tool runs
        await new Promise((r) => setTimeout(r, 30));
        toolFinished = true;
        return 'ok';
      },
    });
    const agent = new Agent({ model: new ToolCallingModel(), tools: [slow], printer: false });
    const result = await drain(agent.stream('go', { cancelSignal: controller.signal }));
    expect(toolFinished).toBe(true);
    expect(result.stopReason).toBe('cancelled');
    expect(hasDanglingToolUse(agent.messages)).toBe(false);
    expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
  });

  it('can run a normal turn after a cancelled one', async () => {
    const agent = new Agent({ model: new SlowTextModel(), printer: false });
    const controller = new AbortController();
    await drain(agent.stream('first', { cancelSignal: controller.signal }), (n) => {
      if (n === 3) controller.abort();
    });
    const result = await agent.invoke('second');
    expect(result.stopReason).toBe('endTurn');
  });
});
