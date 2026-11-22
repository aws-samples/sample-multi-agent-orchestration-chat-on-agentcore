/**
 * TokenLimitHook: refuse a turn that starts over the limit, wind down a turn
 * that crosses it (refuse tools → grace → cancel), and stop when the caller's
 * tokens are no longer accepted (401/403), while failing open on outages.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UsageSummary } from '@moca/core';

type Result =
  { kind: 'ok'; value: UsageSummary } | { kind: 'unavailable' } | { kind: 'unauthorized' };
const getSummary = jest.fn<() => Promise<Result>>();
const fetchSummary = jest.fn<() => Promise<Result>>();
jest.unstable_mockModule('../../usage/usage-client.js', () => ({
  SUMMARY_TTL_MS: 60_000,
  getSummary,
  fetchSummary,
}));
let unauthorizedCallback: (() => void) | undefined;
const record = jest.fn();
const flush = jest.fn(async () => {});
let pending = { input: 0, output: 0 };
jest.unstable_mockModule('../../usage/usage-recorder.js', () => ({
  UsageRecorder: jest.fn((_ctx: unknown, onUnauthorized: () => void) => {
    unauthorizedCallback = onUnauthorized;
    return { record, flush };
  }),
  unacknowledgedFor: () => pending,
}));
const emitClientEvent = jest.fn();
jest.unstable_mockModule('../../../libs/context/request-context.js', () => ({
  getCurrentContext: () => ({ userId: 'u', emitClientEvent }),
}));
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger,
  createLogger: () => logger,
}));

const sdk = await import('@strands-agents/sdk');
const { TokenLimitHook } = await import('../token-limit-hook.js');
const { GRACE_MODEL_CALLS } = await import('../turn-budget-hook.js');
const { GRACE_MAX_OUTPUT_TOKENS: G, REASONING_GRACE_MAX_OUTPUT_TOKENS: RG } =
  await import('../token-limit-hook.js');
const { getOffThinkingMode, isReasoningAlwaysOn } = await import('@moca/core');

const MODEL = 'global.anthropic.claude-sonnet-4-6';
/** The cap floor for MODEL (reasoning-capable models get the larger one). */
const FLOOR = (): number =>
  getOffThinkingMode(MODEL) !== undefined || isReasoningAlwaysOn(MODEL) ? RG : G;
const summary = (inputUsed: number, inputLimit: number | null = 1000): Result => ({
  kind: 'ok',
  value: {
    enabled: true,
    period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '2026-11-30T15:00:00.000Z' },
    groups: [],
    models: [
      {
        modelKey: 'anthropic.claude-sonnet-4-6',
        input: { used: inputUsed, limit: inputLimit },
        output: { used: 0, limit: 100 },
        status: 'ok',
      },
    ],
  },
});

type Handler = (event: unknown) => unknown;
function setup() {
  let clock = 0;
  const handlers = new Map<unknown, Handler>();
  new TokenLimitHook(MODEL, () => clock).initAgent({
    addHook: (type: unknown, cb: Handler) => {
      handlers.set(type, cb);
      return () => {};
    },
  } as never);
  let maxTokens: number | undefined = 64_000;
  const model = {
    getConfig: () => ({ maxTokens }),
    updateConfig: (c: { maxTokens?: number }) => {
      maxTokens = c.maxTokens;
    },
  };
  const agent = { model } as never;
  const invocationState = {} as never;
  return {
    advance: (ms: number) => (clock += ms),
    start: async () => {
      const e = new sdk.BeforeInvocationEvent({ agent, messages: [], invocationState });
      await handlers.get(sdk.BeforeInvocationEvent)!(e);
      return e.cancel;
    },
    modelCall: () => {
      const e = new sdk.BeforeModelCallEvent({ agent, model: model as never, invocationState });
      handlers.get(sdk.BeforeModelCallEvent)!(e);
      return e.cancel;
    },
    usage: (inputTokens: number, outputTokens = 0) =>
      handlers.get(sdk.ModelStreamUpdateEvent)!(
        new sdk.ModelStreamUpdateEvent({
          agent,
          invocationState,
          event: {
            type: 'modelMetadataEvent',
            usage: { inputTokens, outputTokens, totalTokens: 0 },
          } as never,
        })
      ),
    tool: () => {
      const e = new sdk.BeforeToolCallEvent({
        agent,
        toolUse: { name: 't', toolUseId: '1', input: {} } as never,
        tool: undefined,
        invocationState,
      });
      handlers.get(sdk.BeforeToolCallEvent)!(e);
      return e.cancel;
    },
    end: () => handlers.get(sdk.AfterInvocationEvent)!({ agent }),
    maxTokens: () => maxTokens,
    afterModelError: (error: Error) => {
      const e = new sdk.AfterModelCallEvent({
        agent,
        model: model as never,
        attemptCount: 1,
        error: error as never,
        invocationState,
      });
      handlers.get(sdk.AfterModelCallEvent)!(e);
      return e.retry;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  pending = { input: 0, output: 0 };
  fetchSummary.mockResolvedValue(summary(0));
});

describe('TokenLimitHook', () => {
  it('meters each model call and flushes at the end of the turn', async () => {
    getSummary.mockResolvedValue(summary(0));
    const h = setup();
    expect(await h.start()).toBe(false);
    expect(h.modelCall()).toBe(false);
    h.usage(10, 2);
    expect(record).toHaveBeenCalledWith(MODEL, expect.objectContaining({ inputTokens: 10 }));
    h.end();
    expect(flush).toHaveBeenCalled();
  });

  it('refuses to start when the limit is already reached', async () => {
    getSummary.mockResolvedValue(summary(1000));
    expect(await setup().start()).toEqual(expect.stringContaining('monthly input token limit'));
  });

  it('winds down a turn that crosses the limit: refuse tools, grace, then cancel', async () => {
    getSummary.mockResolvedValue(summary(900));
    const h = setup();
    await h.start();
    expect(h.modelCall()).toBe(false);
    h.usage(150);
    expect(h.modelCall()).toBe(false); // exhausted now; this call may answer
    expect(emitClientEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'serverWarningEvent',
        warning: expect.objectContaining({
          code: 'tokenLimitReached',
          dimension: 'input',
          limit: 1000,
        }),
      })
    );
    expect(h.tool()).toEqual(expect.stringContaining('Give your final answer now'));
    for (let i = 1; i < GRACE_MODEL_CALLS; i++) expect(h.modelCall()).toBe(false);
    expect(h.modelCall()).toEqual(expect.stringContaining('[Stopped'));
  });

  it('fails open when the Backend is unavailable', async () => {
    getSummary.mockResolvedValue({ kind: 'unavailable' });
    const h = setup();
    expect(await h.start()).toBe(false);
    h.usage(10 ** 9);
    expect(h.modelCall()).toBe(false);
    expect(h.tool()).toBe(false);
  });

  it('stops after repeated 401/403 (tokens no longer renewed)', async () => {
    getSummary.mockResolvedValue({ kind: 'unauthorized' });
    const h = setup();
    await h.start(); // strike 1
    expect(h.modelCall()).toBe(false);
    unauthorizedCallback!(); // strike 2 from a failed POST
    expect(emitClientEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        warning: expect.objectContaining({ code: 'usageMeteringUnavailable' }),
      })
    );
    expect(h.tool()).not.toBe(false);
  });

  it('re-reads the summary in the background after the TTL', async () => {
    getSummary.mockResolvedValue(summary(0));
    const h = setup();
    await h.start();
    h.modelCall();
    expect(fetchSummary).not.toHaveBeenCalled();
    h.advance(60_000);
    h.modelCall();
    expect(fetchSummary).toHaveBeenCalledTimes(1);
  });

  it('does nothing for unlimited models', async () => {
    getSummary.mockResolvedValue(summary(10 ** 12, null));
    const h = setup();
    expect(await h.start()).toBe(false);
    expect(h.modelCall()).toBe(false);
  });

  // Regression: a refresh used to reset `remaining` from a summary that lacks
  // usage still queued for the Backend, handing those tokens back.
  it('subtracts unacknowledged usage when applying a refreshed summary', async () => {
    getSummary.mockResolvedValue(summary(0));
    const h = setup();
    await h.start();
    h.modelCall();
    h.usage(950); // local: 50 left
    pending = { input: 950, output: 0 }; // not yet acknowledged by the Backend
    fetchSummary.mockResolvedValue(summary(0)); // Backend has not seen it
    h.advance(60_000);
    h.modelCall(); // triggers the refresh
    await Promise.resolve();
    await Promise.resolve();
    h.usage(60); // would still be under the limit if the refresh had reset to 1000
    expect(h.modelCall()).toBe(false); // exhausted on this call (grace starts)
    expect(emitClientEvent).toHaveBeenCalledWith(
      expect.objectContaining({ warning: expect.objectContaining({ code: 'tokenLimitReached' }) })
    );
  });

  it('counts unacknowledged usage at turn start (a turn that just ended)', async () => {
    getSummary.mockResolvedValue(summary(400));
    pending = { input: 600, output: 0 };
    expect(await setup().start()).toEqual(expect.stringContaining('limit'));
  });

  // Regression (observed against real Bedrock): grace calls were bounded only
  // by the model's maxOutputTokens, so a 250-token limit ended at 761.
  it('caps output for the grace calls and restores it after the turn', async () => {
    getSummary.mockResolvedValue(summary(990));
    const h = setup();
    await h.start();
    h.modelCall();
    // Only 100 output tokens left: capped at the floor from the first call.
    expect(h.maxTokens()).toBe(FLOOR());
    h.usage(20);
    h.modelCall(); // exhausted
    expect(h.maxTokens()).toBe(FLOOR());
    h.end();
    expect(h.maxTokens()).toBe(64_000);
  });

  it('caps a single call near the output limit, but not far from it', async () => {
    const near = summary(0);
    if (near.kind === 'ok') {
      (near.value.models[0] as { output: { used: number; limit: number } }).output = {
        used: 90_000,
        limit: 100_000,
      };
    }
    getSummary.mockResolvedValue(near);
    const h = setup();
    await h.start();
    h.modelCall();
    expect(h.maxTokens()).toBe(Math.max(10_000, FLOOR())); // remaining output, unless below the floor
    h.usage(0, 8_000);
    h.modelCall();
    expect(h.maxTokens()).toBe(FLOOR()); // floor once remaining is small
    h.end();
    expect(h.maxTokens()).toBe(64_000);

    getSummary.mockResolvedValue(summary(0)); // 100 output left: below the floor, so the floor applies
    const far = setup();
    await far.start();
    far.modelCall();
    expect(far.maxTokens()).toBe(FLOOR());
  });

  const maxTokensError = (text: string) =>
    Object.assign(new Error('Model reached maximum token limit.'), {
      name: 'MaxTokensError',
      partialMessage: { content: [{ type: 'textBlock', text }] },
    });

  it('turns a MaxTokensError on a call it capped into the final answer', async () => {
    getSummary.mockResolvedValue(summary(0)); // 100 output left → capped from the first call
    const h = setup();
    await h.start();
    h.modelCall();
    expect(h.afterModelError(maxTokensError('Rome was founded'))).toBe(true);
    expect(emitClientEvent).toHaveBeenCalledWith(
      expect.objectContaining({ warning: expect.objectContaining({ code: 'tokenLimitReached' }) })
    );
    const replay = h.modelCall();
    expect(replay).toEqual(expect.stringContaining('Rome was founded'));
    expect(replay).toEqual(expect.stringContaining('cut short'));
  });

  it('leaves MaxTokensError alone when it did not cap the call', async () => {
    const unlimited = summary(0, null);
    if (unlimited.kind === 'ok') {
      (
        unlimited.value.models[0] as { output: { used: number; limit: number | null } }
      ).output.limit = null;
    }
    getSummary.mockResolvedValue(unlimited); // no limit for this model → never capped
    const h = setup();
    await h.start();
    h.modelCall();
    expect(h.afterModelError(maxTokensError('x'))).toBeFalsy();
  });

  it('says no answer was written when the capped budget went to reasoning', async () => {
    getSummary.mockResolvedValue(summary(0));
    const h = setup();
    await h.start();
    h.modelCall();
    h.afterModelError(maxTokensError(''));
    expect(h.modelCall()).toEqual(expect.stringContaining('before an answer was written'));
  });

  it('uses a larger floor for reasoning models', async () => {
    const { REASONING_GRACE_MAX_OUTPUT_TOKENS, reasoningActive } =
      await import('../token-limit-hook.js');
    const model = (thinking?: { type: string }) =>
      ({
        getConfig: () => ({ additionalRequestFields: thinking ? { thinking } : undefined }),
      }) as never;
    expect(reasoningActive('global.anthropic.claude-opus-5-5', model({ type: 'adaptive' }))).toBe(
      true
    );
    expect(reasoningActive('global.anthropic.claude-opus-5-5', model({ type: 'disabled' }))).toBe(
      false
    );
    expect(reasoningActive('openai.gpt-5.5', model())).toBe(true);
    // Default with no thinking field follows the registry (off payload ⇒ default on).
    const core = await import('@moca/core');
    for (const id of ['global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-sonnet-4-6']) {
      expect(reasoningActive(id, model())).toBe(
        core.getOffThinkingMode(id) !== undefined || core.isReasoningAlwaysOn(id)
      );
    }
    expect(reasoningActive('openai.gpt-oss-120b-1:0', model())).toBe(false);
    expect(REASONING_GRACE_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
  });

  // Regression: every call with an output limit went through capOutput, so a
  // MaxTokensError from the model's own ceiling was reported as the monthly limit.
  it('leaves a MaxTokensError alone when the cap did not lower maxTokens', async () => {
    const roomy = summary(0);
    if (roomy.kind === 'ok') {
      (roomy.value.models[0] as { output: { used: number; limit: number } }).output = {
        used: 0,
        limit: 10_000_000,
      };
    }
    getSummary.mockResolvedValue(roomy);
    const h = setup();
    await h.start();
    h.modelCall();
    expect(h.maxTokens()).toBe(64_000); // far from the limit: not lowered
    expect(h.afterModelError(maxTokensError('long answer'))).toBeFalsy();
    expect(emitClientEvent).not.toHaveBeenCalled();
  });

  // Regression: a refresh that drops the limit mid-turn crashed detail() on null.
  it('keeps a cut-off answer without crashing when the limit vanished mid-turn', async () => {
    getSummary.mockResolvedValue(summary(0)); // capped from the first call
    const unlimited = summary(0, null);
    if (unlimited.kind === 'ok') {
      (
        unlimited.value.models[0] as { output: { used: number; limit: number | null } }
      ).output.limit = null;
    }
    fetchSummary.mockResolvedValue(unlimited);
    const h = setup();
    await h.start();
    h.modelCall();
    h.advance(60_000);
    h.modelCall(); // refresh → remaining becomes null; cap still in force
    await Promise.resolve();
    await Promise.resolve();
    expect(() => h.afterModelError(maxTokensError('partial'))).not.toThrow();
    expect(h.modelCall()).toEqual(expect.stringContaining('partial'));
  });
});
