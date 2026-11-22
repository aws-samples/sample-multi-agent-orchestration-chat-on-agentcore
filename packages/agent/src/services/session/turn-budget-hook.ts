/**
 * Turn Budget Hook
 *
 * Bounds how much work one agent invocation (turn) may do: model calls,
 * wall-clock time, cumulative input tokens, and near-identical tool calls.
 *
 * Why this is needed:
 * Nothing else stops a model that never decides it is done. A sub-agent
 * once inspected the same diagram region by region for 2 h 41 min
 * (1,541 model calls, context up to 727K tokens, ~$800). The conversation
 * manager only reacts to context overflow, and `call_agent`'s wait timeout
 * only stops the parent from polling.
 *
 * Why not cancel the model call as soon as the budget runs out:
 * the turn's final assistant text is all a sub-agent hands back to its parent.
 * Cutting it off mid-task would discard everything it found. Instead, once the
 * budget is exhausted every tool call is refused with an instruction to answer
 * now, and only after GRACE_MODEL_CALLS more calls is the model call itself
 * cancelled.
 */

import {
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
} from '@strands-agents/sdk';
import type { Plugin, LocalAgent } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';

export interface TurnBudget {
  maxModelCalls: number;
  /** Omit for no wall-clock limit (long user turns are legitimate). */
  maxDurationMs?: number;
  /** Sum of the SDK's projected input tokens over the turn's model calls. */
  maxInputTokens: number;
  /** Calls to one tool whose input differs only in numbers (e.g. view_image regions). */
  maxSimilarToolCalls: number;
}

export const MAIN_TURN_BUDGET: TurnBudget = {
  maxModelCalls: 300,
  maxInputTokens: 100_000_000,
  maxSimilarToolCalls: 20,
};

export const SUB_AGENT_TURN_BUDGET: TurnBudget = {
  maxModelCalls: 150,
  maxDurationMs: 30 * 60 * 1000,
  maxInputTokens: 30_000_000,
  maxSimilarToolCalls: 20,
};

/** Model calls allowed after exhaustion so the model can write its final answer. */
export const GRACE_MODEL_CALLS = 2;

/**
 * Key under which tool calls count as "the same": tool name plus input with
 * every number blanked, so re-viewing one image at shifting regions, or
 * paging the same query, collapses to one key.
 */
export function similarToolCallKey(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(input, (_key, value: unknown) =>
    typeof value === 'number' ? '#' : value
  )}`;
}

export class TurnBudgetHook implements Plugin {
  readonly name = 'moca:turn-budget-hook';

  private startedAt = 0;
  private modelCalls = 0;
  private inputTokens = 0;
  private exhaustedReason: string | undefined;
  private exhaustedAtCall = 0;
  private readonly similarCalls = new Map<string, number>();

  constructor(
    private readonly budget: TurnBudget,
    private readonly now: () => number = Date.now
  ) {}

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, () => this.reset());
    agent.addHook(BeforeModelCallEvent, (event) => this.onBeforeModelCall(event));
    agent.addHook(BeforeToolCallEvent, (event) => this.onBeforeToolCall(event));
  }

  private reset(): void {
    this.startedAt = this.now();
    this.modelCalls = 0;
    this.inputTokens = 0;
    this.exhaustedReason = undefined;
    this.exhaustedAtCall = 0;
    this.similarCalls.clear();
  }

  private onBeforeModelCall(event: BeforeModelCallEvent): void {
    this.modelCalls++;
    this.inputTokens += event.projectedInputTokens ?? 0;

    if (this.exhaustedReason === undefined) {
      const reason = this.checkBudget();
      if (reason === undefined) return;
      this.exhaustedReason = reason;
      this.exhaustedAtCall = this.modelCalls;
      logger.warn(
        {
          reason,
          modelCalls: this.modelCalls,
          inputTokens: this.inputTokens,
          elapsedMs: this.now() - this.startedAt,
        },
        '[TURN_BUDGET] Turn budget exhausted; refusing further tool calls'
      );
      return;
    }

    if (this.modelCalls - this.exhaustedAtCall >= GRACE_MODEL_CALLS) {
      logger.warn(
        { reason: this.exhaustedReason, modelCalls: this.modelCalls },
        '[TURN_BUDGET] Grace calls used up; ending the turn'
      );
      event.cancel = `[Stopped: this turn reached its limit (${this.exhaustedReason}). Ask me to continue if more work is needed.]`;
    }
  }

  private checkBudget(): string | undefined {
    const { maxModelCalls, maxDurationMs, maxInputTokens } = this.budget;
    if (this.modelCalls > maxModelCalls) return `${maxModelCalls} model calls`;
    if (this.inputTokens > maxInputTokens) {
      return `${Math.round(maxInputTokens / 1_000_000)}M input tokens`;
    }
    if (maxDurationMs !== undefined && this.now() - this.startedAt > maxDurationMs) {
      return `${Math.round(maxDurationMs / 60_000)} minutes`;
    }
    return undefined;
  }

  private onBeforeToolCall(event: BeforeToolCallEvent): void {
    if (this.exhaustedReason !== undefined) {
      event.cancel = `Turn budget exhausted (${this.exhaustedReason}). Do not call any more tools. Give your final answer now, using what you already have.`;
      return;
    }

    const { name, input } = event.toolUse;
    const key = similarToolCallKey(name, input);
    const count = (this.similarCalls.get(key) ?? 0) + 1;
    this.similarCalls.set(key, count);
    if (count <= this.budget.maxSimilarToolCalls) return;

    if (count === this.budget.maxSimilarToolCalls + 1) {
      logger.warn({ tool: name, count }, '[TURN_BUDGET] Refusing repeated tool call');
    }
    event.cancel = `Refused: ${name} has already been called ${this.budget.maxSimilarToolCalls} times this turn with essentially the same input. Use the results you already have; do not call it this way again.`;
  }
}
