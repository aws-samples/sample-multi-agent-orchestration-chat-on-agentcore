/**
 * Unit tests for TurnBudgetHook.
 *
 * The hook must let a turn wrap up (refuse tools, allow grace model calls)
 * before ending it, stop near-identical tool-call loops, and reset per turn.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  type HookableEvent,
  type LocalAgent,
  type Model,
} from '@strands-agents/sdk';
import {
  GRACE_MODEL_CALLS,
  SUB_AGENT_TURN_BUDGET,
  TurnBudgetHook,
  similarToolCallKey,
  type TurnBudget,
} from '../turn-budget-hook.js';

type Handler = (event: HookableEvent) => void;

const BUDGET: TurnBudget = {
  maxModelCalls: 3,
  maxDurationMs: 60_000,
  maxInputTokens: 1_000,
  maxSimilarToolCalls: 2,
};

function setup(budget: TurnBudget = BUDGET) {
  let clock = 0;
  const handlers = new Map<unknown, Handler>();
  new TurnBudgetHook(budget, () => clock).initAgent({
    addHook: (eventType: unknown, callback: Handler) => {
      handlers.set(eventType, callback);
      return () => {};
    },
  } as unknown as LocalAgent);

  const agent = {} as LocalAgent;
  const startTurn = () =>
    handlers.get(BeforeInvocationEvent)!(
      new BeforeInvocationEvent({ agent, messages: [], invocationState: {} as never })
    );
  const modelCall = (projectedInputTokens?: number) => {
    const event = new BeforeModelCallEvent({
      agent,
      model: {} as Model,
      invocationState: {} as never,
      ...(projectedInputTokens !== undefined && { projectedInputTokens }),
    });
    handlers.get(BeforeModelCallEvent)!(event);
    return event.cancel;
  };
  const toolCall = (name: string, input: unknown) => {
    const event = new BeforeToolCallEvent({
      agent,
      toolUse: { name, toolUseId: 't', input } as never,
      tool: undefined,
      invocationState: {} as never,
    });
    handlers.get(BeforeToolCallEvent)!(event);
    return event.cancel;
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { startTurn, modelCall, toolCall, advance };
}

describe('TurnBudgetHook', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    h.startTurn();
  });

  it('allows everything within budget', () => {
    for (let i = 0; i < BUDGET.maxModelCalls; i++) expect(h.modelCall(10)).toBe(false);
    expect(h.toolCall('view_image', { imagePath: 'a.png' })).toBe(false);
  });

  it('refuses tools once model calls are exhausted, then ends the turn after grace calls', () => {
    for (let i = 0; i < BUDGET.maxModelCalls; i++) h.modelCall();

    // First over-budget call proceeds so the model can answer.
    expect(h.modelCall()).toBe(false);
    expect(h.toolCall('view_image', { imagePath: 'a.png' })).toEqual(
      expect.stringContaining('Give your final answer now')
    );
    for (let i = 1; i < GRACE_MODEL_CALLS; i++) expect(h.modelCall()).toBe(false);

    expect(h.modelCall()).toEqual(expect.stringContaining('3 model calls'));
  });

  it('exhausts on cumulative projected input tokens', () => {
    h.modelCall(600);
    h.modelCall(600);
    expect(h.toolCall('s3_list_files', {})).toEqual(expect.stringContaining('input tokens'));
  });

  it('exhausts on wall-clock time when a duration limit is set', () => {
    h.advance(BUDGET.maxDurationMs! + 1);
    h.modelCall();
    expect(h.toolCall('s3_list_files', {})).toEqual(expect.stringContaining('1 minutes'));
  });

  it('has no wall-clock limit when maxDurationMs is omitted', () => {
    h = setup({ ...BUDGET, maxDurationMs: undefined });
    h.startTurn();
    h.advance(10 * 60 * 60 * 1000);
    h.modelCall();
    expect(h.toolCall('s3_list_files', {})).toBe(false);
  });

  it('refuses a tool called again with input differing only in numbers', () => {
    const view = (x: number) =>
      h.toolCall('view_image', {
        imagePath: 'arch.png',
        region: { x, y: 0, width: 700, height: 450 },
      });

    expect(view(0)).toBe(false);
    expect(view(700)).toBe(false);
    expect(view(1400)).toEqual(expect.stringContaining('Refused: view_image'));
    // A different image is a different key.
    expect(h.toolCall('view_image', { imagePath: 'other.png' })).toBe(false);
  });

  it('resets all counters at the start of each turn', () => {
    for (let i = 0; i < BUDGET.maxModelCalls + GRACE_MODEL_CALLS; i++) h.modelCall();
    h.toolCall('x', {});
    h.toolCall('x', {});

    h.startTurn();

    expect(h.modelCall()).toBe(false);
    expect(h.toolCall('x', {})).toBe(false);
  });

  it('would have stopped the 2026-11-21 runaway within its first minutes', () => {
    // Observed: 2 view_image region crops per model call on one file.
    h = setup(SUB_AGENT_TURN_BUDGET);
    h.startTurn();
    let refusedAtCall = -1;
    for (let call = 1; call <= 1_541 && refusedAtCall < 0; call++) {
      h.modelCall(12_000 + call * 1_200);
      for (const x of [0, 700]) {
        const cancel = h.toolCall('view_image', {
          imagePath: '/tmp/ws/development/docs/architecture.png',
          region: { x: x + call, y: 0, width: 700, height: 450 },
        });
        if (cancel) refusedAtCall = call;
      }
    }
    expect(refusedAtCall).toBeGreaterThan(0);
    expect(refusedAtCall).toBeLessThanOrEqual(SUB_AGENT_TURN_BUDGET.maxSimilarToolCalls);
  });
});

describe('similarToolCallKey', () => {
  it('blanks numbers but keeps strings and structure', () => {
    expect(similarToolCallKey('t', { a: 1, b: 'x', c: [2, 'y'] })).toBe(
      't:{"a":"#","b":"x","c":["#","y"]}'
    );
  });
});
