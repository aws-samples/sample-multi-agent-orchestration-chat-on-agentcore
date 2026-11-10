/**
 * Drives a real Strands Agent with a scripted model to pin the submit-tool
 * contract: the turn ends right after `submit_workflow_result` (no further
 * model call), so no empty assistant text lands in the step's history.
 */

import { describe, expect, it } from '@jest/globals';
import { Agent, Model, type BaseModelConfig, type ModelStreamEvent } from '@strands-agents/sdk';
import {
  buildStepResult,
  createSubmitResultTool,
  lastAssistantText,
  turnReplyText,
} from '../workflow-step.js';

function* toolUseTurn(input: Record<string, unknown>): Generator<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;
  // The deliverable is streamed as reply text before the tool call.
  yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: { type: 'textDelta', text: 'the deliverable' },
  } as ModelStreamEvent;
  yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
  yield {
    type: 'modelContentBlockStartEvent',
    start: { type: 'toolUseStart', name: 'submit_workflow_result', toolUseId: 't1' },
  } as ModelStreamEvent;
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) },
  } as ModelStreamEvent;
  yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
  yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' } as ModelStreamEvent;
}

function* emptyTextTurn(): Generator<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;
  yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: { type: 'textDelta', text: ' ' },
  } as ModelStreamEvent;
  yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' } as ModelStreamEvent;
}

class ScriptedModel extends Model {
  calls = 0;
  private config: BaseModelConfig = { modelId: 'scripted' };
  constructor(private readonly input: Record<string, unknown>) {
    super();
  }
  getConfig(): BaseModelConfig {
    return this.config;
  }
  updateConfig(c: BaseModelConfig): void {
    this.config = { ...this.config, ...c };
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    // A second call would reproduce the empty reply that broke revisions.
    yield* this.calls === 1 ? toolUseTurn(this.input) : emptyTextTurn();
  }
}

describe('createSubmitResultTool', () => {
  it('ends the turn after submission without calling the model again', async () => {
    const submit = createSubmitResultTool();
    const model = new ScriptedModel({ status: 'done' });
    const agent = new Agent({
      model,
      tools: [submit.tool],
      plugins: [submit.plugin],
      printer: false,
    });

    const result = await agent.invoke('do the step');

    expect(model.calls).toBe(1);
    expect(result.stopReason).toBe('endTurn');
    expect(submit.getSubmitted()).toEqual({ status: 'done' });
    const blankText = agent.messages.some((m) =>
      m.content.some((b) => b.type === 'textBlock' && b.text.trim() === '')
    );
    expect(blankText).toBe(false);
    expect(buildStepResult(submit.getSubmitted(), agent, 's1')).toEqual({
      status: 'done',
      output: 'the deliverable',
      sessionId: 's1',
    });
  });

  it('keeps each turn independent: a new tool instance starts unsubmitted', () => {
    expect(createSubmitResultTool().getSubmitted()).toBeUndefined();
  });
});

describe('turnReplyText', () => {
  it('collects assistant text since the turn prompt, skipping tool results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'textBlock', text: 'old prompt' }] },
      { role: 'assistant', content: [{ type: 'textBlock', text: 'old answer' }] },
      { role: 'user', content: [{ type: 'textBlock', text: 'new prompt' }] },
      {
        role: 'assistant',
        content: [{ type: 'textBlock', text: 'part 1' }, { type: 'toolUseBlock' }],
      },
      { role: 'user', content: [{ type: 'toolResultBlock' }] },
      { role: 'assistant', content: [{ type: 'textBlock', text: 'part 2' }] },
    ] as unknown as Parameters<typeof turnReplyText>[0];
    expect(turnReplyText(messages)).toBe('part 1\n\npart 2');
  });
});

describe('buildStepResult', () => {
  it('falls back to the last non-empty assistant text', () => {
    const agent = {
      messages: [
        { role: 'assistant', content: [{ type: 'textBlock', text: 'answer' }] },
        { role: 'user', content: [{ type: 'textBlock', text: 'thanks' }] },
        { role: 'assistant', content: [{ type: 'textBlock', text: '  ' }] },
      ],
    } as unknown as Parameters<typeof lastAssistantText>[0];
    expect(buildStepResult(undefined, agent, undefined)).toEqual({
      status: 'done',
      output: 'answer',
      implicit: true,
      sessionId: undefined,
    });
  });

  it('uses the submitted note only when the reply text is empty', () => {
    const res = buildStepResult(
      { status: 'blocked', output: 'note', feedback: 'fix A', targetStepId: 'a' },
      { messages: [] } as never,
      's'
    );
    expect(res).toEqual({
      status: 'blocked',
      output: 'note',
      feedback: 'fix A',
      targetStepId: 'a',
      sessionId: 's',
    });
  });

  it('truncates oversized outputs', () => {
    const big = 'x'.repeat(25_000);
    const res = buildStepResult(
      { status: 'done' },
      { messages: [{ role: 'assistant', content: [{ type: 'textBlock', text: big }] }] } as never,
      's'
    );
    expect(res.output.length).toBeLessThan(21_000);
    expect(res.output).toMatch(/…\[truncated\]$/);
  });
});
