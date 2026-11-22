/**
 * Token Limit Hook
 *
 * Meters every model call against the caller's monthly per-model token limit
 * (owned by the Backend, see docs/adr/token-usage-limits.md) and stops the
 * turn once the limit is reached.
 *
 * Why stop gracefully: a sub-agent's final text is all it hands back, so the
 * turn is wound down the same way as TurnBudgetHook — tools are refused with
 * "answer now", and only after GRACE_MODEL_CALLS more calls is the model call
 * itself cancelled.
 *
 * Why stop on 401/403 instead of failing open: it means the caller's tokens
 * stopped being renewed (tab closed mid-turn, trigger turn past its 1 h
 * machine token). Continuing would let the turn run unmetered for hours.
 * Backend outages (5xx / timeouts) still fail open.
 */

import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  ModelStreamUpdateEvent,
} from '@strands-agents/sdk';
import type { Plugin, LocalAgent, Model } from '@strands-agents/sdk';
import {
  TOKEN_LIMIT_REACHED,
  USAGE_METERING_UNAVAILABLE,
  getBedrockEndpoint,
  getMaxOutputTokens,
  getOffThinkingMode,
  isReasoningAlwaysOn,
  modelUsageKey,
  type TokenDimension,
  type TokenLimitEventDetail,
  type UsageSummary,
} from '@moca/core';
import { logger } from '../../libs/logger/index.js';
import { getCurrentContext, type RequestContext } from '../../libs/context/request-context.js';
import { GRACE_MODEL_CALLS } from './turn-budget-hook.js';
import { normalizeUsage, totalInput, type SdkUsage } from '../usage/normalize.js';
import {
  SUMMARY_TTL_MS,
  fetchSummary,
  getSummary,
  type UsageCallResult,
} from '../usage/usage-client.js';
import { UsageRecorder, unacknowledgedFor } from '../usage/usage-recorder.js';

/** Consecutive 401/403 responses that mean "tokens are no longer renewed". */
export const UNAUTHORIZED_STRIKES_TO_STOP = 2;

/**
 * Floor for the per-call output cap applied near and past the output limit.
 * Without a cap one call is bounded only by the model's maxOutputTokens (up
 * to 128K), so a single answer near the limit — or a grace call after it —
 * could overshoot by far more than the limit itself. Not lower: hitting the
 * cap raises MaxTokensError, which ends the turn with an error instead of the
 * answer, so an ordinary final answer must still fit.
 */
export const GRACE_MAX_OUTPUT_TOKENS = 4096;

/**
 * The same floor when the model reasons. Reasoning tokens count against
 * maxTokens; observed on Opus 5.5 at depth `max`, a 4096 cap was spent entirely
 * on reasoning and the turn ended with no answer text at all.
 */
export const REASONING_GRACE_MAX_OUTPUT_TOKENS = 16_384;

/** Whether calls of this model spend output tokens on reasoning. */
export function reasoningActive(modelId: string, model: Model): boolean {
  if (getBedrockEndpoint(modelId) === 'mantle') return true; // gpt-5.x reason by default
  const thinking = (
    model.getConfig() as { additionalRequestFields?: { thinking?: { type?: string } } }
  ).additionalRequestFields?.thinking;
  if (thinking) return thinking.type !== 'disabled';
  // No thinking field: the model's default. A model with an `off` payload or
  // always-on reasoning thinks unless told otherwise.
  return getOffThinkingMode(modelId) !== undefined || isReasoningAlwaysOn(modelId);
}

interface Remaining {
  input: number | null;
  output: number | null;
  limitInput: number | null;
  limitOutput: number | null;
  resetsAt: string;
}

/** Remaining tokens for `modelKey`, or null when the summary sets no limit. */
export function remainingFor(summary: UsageSummary, modelKey: string): Remaining | null {
  if (!summary.enabled) return null;
  const m = summary.models.find((x) => x.modelKey === modelKey);
  if (!m || (m.input.limit === null && m.output.limit === null)) return null;
  return {
    input: m.input.limit === null ? null : m.input.limit - m.input.used,
    output: m.output.limit === null ? null : m.output.limit - m.output.used,
    limitInput: m.input.limit,
    limitOutput: m.output.limit,
    resetsAt: summary.period.resetsAt,
  };
}

export function exhaustedDimension(r: Remaining | null): TokenDimension | undefined {
  if (!r) return undefined;
  if (r.input !== null && r.input <= 0) return 'input';
  if (r.output !== null && r.output <= 0) return 'output';
  return undefined;
}

interface Exhaustion {
  code: typeof TOKEN_LIMIT_REACHED | typeof USAGE_METERING_UNAVAILABLE;
  detail?: TokenLimitEventDetail;
}

export class TokenLimitHook implements Plugin {
  readonly name = 'moca:token-limit-hook';

  private readonly modelKey: string;
  private ctx: RequestContext | undefined;
  private recorder: UsageRecorder | undefined;
  private remaining: Remaining | null = null;
  private fetchedAt = 0;
  private refreshing = false;
  private modelCalls = 0;
  private exhaustedAtCall = 0;
  private exhaustion: Exhaustion | undefined;
  private unauthorizedStrikes = 0;

  constructor(
    private readonly modelId: string,
    private readonly now: () => number = Date.now
  ) {
    this.modelKey = modelUsageKey(modelId);
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, (event) => this.onBeforeInvocation(event));
    agent.addHook(ModelStreamUpdateEvent, (event) => this.onStreamUpdate(event));
    agent.addHook(BeforeModelCallEvent, (event) => this.onBeforeModelCall(event));
    agent.addHook(BeforeToolCallEvent, (event) => this.onBeforeToolCall(event));
    agent.addHook(AfterModelCallEvent, (event) => this.onAfterModelCall(event));
    // Not awaited: the client's completion event must not wait for metering.
    agent.addHook(AfterInvocationEvent, (event) => {
      this.restoreOutput(event.agent.model);
      void this.recorder?.flush();
    });
  }

  private async onBeforeInvocation(event: BeforeInvocationEvent): Promise<void> {
    // A previous invocation that died before AfterInvocation must not leave the cap on.
    this.restoreOutput(event.agent.model);
    this.ctx = getCurrentContext();
    this.recorder = new UsageRecorder(this.ctx, () => this.onUnauthorized());
    this.modelCalls = 0;
    this.exhaustedAtCall = 0;
    this.exhaustion = undefined;
    this.unauthorizedStrikes = 0;
    this.truncatedAnswer = undefined;

    this.apply(await getSummary(this.ctx));
    const dimension = exhaustedDimension(this.remaining);
    if (dimension) {
      // Already over the limit (sub-agents, workflow steps — the main turn is
      // refused earlier with a structured event): do not start at all.
      const detail = this.detail(dimension);
      logger.warn({ ...detail }, '[TOKEN_LIMIT] Refusing turn: monthly limit already reached');
      event.cancel = `[Stopped: the monthly ${dimension} token limit for ${this.modelKey} is reached (${detail.used} / ${detail.limit}). It resets at ${detail.resetsAt}.]`;
    }
  }

  private apply(result: UsageCallResult<UsageSummary>): void {
    if (result.kind === 'unauthorized') {
      this.onUnauthorized();
      return;
    }
    if (result.kind !== 'ok') return; // unavailable / throttled: fail open
    this.unauthorizedStrikes = 0;
    this.fetchedAt = result.at ?? this.now();
    // The summary cannot include usage the Backend has not acknowledged yet
    // (queued or in flight); without subtracting it, every refresh would hand
    // back tokens already spent this turn.
    const remaining = remainingFor(result.value, this.modelKey);
    const pending = unacknowledgedFor(this.ctx?.userId);
    if (remaining) {
      if (remaining.input !== null) remaining.input -= pending.input;
      if (remaining.output !== null) remaining.output -= pending.output;
    }
    this.remaining = remaining;
  }

  private onUnauthorized(): void {
    this.unauthorizedStrikes++;
    if (this.unauthorizedStrikes >= UNAUTHORIZED_STRIKES_TO_STOP && !this.exhaustion) {
      this.exhaust({ code: USAGE_METERING_UNAVAILABLE });
    }
  }

  private onStreamUpdate(event: ModelStreamUpdateEvent): void {
    const inner = event.event as { type?: string; usage?: SdkUsage };
    if (inner.type !== 'modelMetadataEvent' || !inner.usage) return;
    this.recorder?.record(this.modelId, inner.usage);
    if (this.remaining) {
      const n = normalizeUsage(this.modelId, inner.usage);
      if (this.remaining.input !== null) this.remaining.input -= totalInput(n);
      if (this.remaining.output !== null) this.remaining.output -= n.outputTokens;
    }
  }

  private onBeforeModelCall(event: BeforeModelCallEvent): void {
    this.modelCalls++;
    this.refreshInBackground();

    if (!this.exhaustion) {
      const dimension = exhaustedDimension(this.remaining);
      if (!dimension) {
        // Near the output limit, keep one call from overshooting by up to the
        // model's full maxOutputTokens.
        const left = this.remaining?.output;
        if (left !== null && left !== undefined) {
          this.capOutput(event.model, Math.max(left, this.floor(event.model)));
        }
        return;
      }
      this.exhaust({ code: TOKEN_LIMIT_REACHED, detail: this.detail(dimension) });
      this.capOutput(event.model, this.floor(event.model));
      return;
    }
    if (this.truncatedAnswer !== undefined) {
      // Replay the answer our cap cut off as the turn's final message instead
      // of a MaxTokensError (no further Bedrock call).
      event.cancel = this.truncatedAnswer.trim()
        ? `${this.truncatedAnswer}\n\n[Stopped: the answer was cut short because the monthly token limit for ${this.modelKey} is nearly or fully used.]`
        : `[Stopped: the monthly token limit for ${this.modelKey} is nearly or fully used, and it ran out before an answer was written (the model spent it reasoning). Try a lower reasoning depth or another model.]`;
      this.truncatedAnswer = undefined;
      return;
    }
    this.capOutput(event.model, this.floor(event.model));
    if (this.modelCalls - this.exhaustedAtCall >= GRACE_MODEL_CALLS) {
      event.cancel =
        this.exhaustion.code === USAGE_METERING_UNAVAILABLE
          ? '[Stopped: usage could not be metered because the sign-in session expired. Reopen the page to continue.]'
          : `[Stopped: the monthly token limit for ${this.modelKey} was reached. It resets at ${this.exhaustion.detail?.resetsAt}.]`;
    }
  }

  /** Saved maxTokens while capped; `null` = not capped. */
  private savedMaxTokens: number | undefined | null = null;

  /** Text of an answer our output cap cut off, replayed by the next (retried) model call. */
  private truncatedAnswer: string | undefined;

  /**
   * A call this hook capped ran into maxTokens. Without intervention the SDK
   * throws MaxTokensError and the turn ends with an error, losing an answer
   * that was already generated (and metered). Keep its text and retry: the
   * retried call is cancelled in onBeforeModelCall with that text.
   */
  private onAfterModelCall(event: AfterModelCallEvent): void {
    const error = event.error as (Error & { partialMessage?: { content?: unknown[] } }) | undefined;
    if (!error || error.name !== 'MaxTokensError' || this.savedMaxTokens === null) return;
    this.truncatedAnswer = (error.partialMessage?.content ?? [])
      .filter(
        (b): b is { type: string; text: string } => (b as { type?: string }).type === 'textBlock'
      )
      .map((b) => b.text)
      .join('');
    if (!this.exhaustion) {
      const dimension = exhaustedDimension(this.remaining) ?? 'output';
      this.exhaust({ code: TOKEN_LIMIT_REACHED, detail: this.detail(dimension) });
    }
    event.retry = true;
  }

  private floor(model: Model): number {
    return reasoningActive(this.modelId, model)
      ? REASONING_GRACE_MAX_OUTPUT_TOKENS
      : GRACE_MAX_OUTPUT_TOKENS;
  }

  /** Lower the model's maxTokens to `cap` (never raise it above what was configured). */
  private capOutput(model: Model, cap: number): void {
    const current = (model.getConfig() as { maxTokens?: number }).maxTokens;
    if (this.savedMaxTokens === null) this.savedMaxTokens = current;
    const configured = this.savedMaxTokens ?? getMaxOutputTokens(this.modelId);
    const next = configured === undefined ? cap : Math.min(configured, cap);
    if (next !== current) model.updateConfig({ maxTokens: next } as never);
  }

  private restoreOutput(model: Model | undefined): void {
    if (this.savedMaxTokens === null || !model) return;
    model.updateConfig({ maxTokens: this.savedMaxTokens } as never);
    this.savedMaxTokens = null;
  }

  private onBeforeToolCall(event: BeforeToolCallEvent): void {
    if (!this.exhaustion) return;
    event.cancel =
      'The monthly token limit for this model has been reached. Do not call any more tools. Give your final answer now, using what you already have.';
  }

  /** Re-read the summary every SUMMARY_TTL_MS without blocking the model call. */
  private refreshInBackground(): void {
    if (this.refreshing || this.now() - this.fetchedAt < SUMMARY_TTL_MS) return;
    this.refreshing = true;
    void fetchSummary(this.ctx)
      .then((r) => this.apply(r))
      .finally(() => {
        this.refreshing = false;
      });
  }

  private detail(dimension: TokenDimension): TokenLimitEventDetail {
    const r = this.remaining!;
    const limit = (dimension === 'input' ? r.limitInput : r.limitOutput) ?? 0;
    const left = (dimension === 'input' ? r.input : r.output) ?? 0;
    return { modelKey: this.modelKey, dimension, used: limit - left, limit, resetsAt: r.resetsAt };
  }

  private exhaust(exhaustion: Exhaustion): void {
    this.exhaustion = exhaustion;
    this.exhaustedAtCall = this.modelCalls;
    logger.warn(
      { code: exhaustion.code, ...exhaustion.detail, modelCalls: this.modelCalls },
      '[TOKEN_LIMIT] Stopping turn; refusing further tool calls'
    );
    this.ctx?.emitClientEvent?.({
      type: 'serverWarningEvent',
      warning: {
        code: exhaustion.code,
        message:
          exhaustion.code === USAGE_METERING_UNAVAILABLE
            ? 'Usage could not be metered because the sign-in session expired.'
            : 'The monthly token limit for this model was reached.',
        ...exhaustion.detail,
      },
    });
  }
}
