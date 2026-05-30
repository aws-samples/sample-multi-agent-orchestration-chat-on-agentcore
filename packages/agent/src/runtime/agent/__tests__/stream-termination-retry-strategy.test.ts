/**
 * Reproduction + fix tests for the transient mid-stream truncation bug.
 *
 * Symptom (reported): the agent aborts mid-task with
 *   [SYSTEM_ERROR] ... Type: ModelError
 *   Details: "Stream ended without completing a message" ...
 *
 * Root cause: Bedrock's ConverseStream can end the event stream cleanly without
 * ever delivering a `messageStop` chunk. The SDK base `Model.streamAggregated()`
 * then exits its loop with no `finalStopReason` and throws a base
 * `ModelError('Stream ended without completing a message')`. The SDK default
 * retry strategy only retries `ModelThrottledError`, so the error propagates and
 * the turn is aborted.
 *
 * These tests are deterministic and offline: a hand-rolled `FakeModel` (the SDK
 * does not export its `TestModelProvider` fixture) drives the real SDK
 * `streamAggregated()` / `Agent` retry loop. No network, no fake timers — the
 * fix strategy is constructed with a zero-delay backoff.
 *
 * Run: cd packages/agent && npm test -- stream-termination-retry-strategy
 */

import { describe, it, expect } from '@jest/globals';
import {
  Agent,
  Model,
  Message,
  TextBlock,
  ModelError,
  MaxTokensError,
  ContextWindowOverflowError,
  ModelThrottledError,
  ConstantBackoff,
  type ModelStreamEvent,
  type BaseModelConfig,
} from '@strands-agents/sdk';
import {
  StreamTerminationRetryStrategy,
  STREAM_INCOMPLETE_MESSAGE,
} from '../stream-termination-retry-strategy.js';

// ---------------------------------------------------------------------------
// Fake model
// ---------------------------------------------------------------------------

/**
 * The full, well-formed event-data sequence for one assistant turn. The SDK
 * turns each yielded value into a class instance via `_convert_to_class_event`,
 * so we yield plain `*EventData` shapes (not pre-built instances).
 */
function* completeTurn(text: string): Generator<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;
  yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: { type: 'textDelta', text },
  } as ModelStreamEvent;
  yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' } as ModelStreamEvent;
}

/**
 * Same sequence as {@link completeTurn} but WITHOUT the trailing
 * `modelMessageStopEvent`. This is exactly the Bedrock truncation: the stream
 * ends after partial content, so `streamAggregated()` never records a stop
 * reason and throws `ModelError('Stream ended without completing a message')`.
 */
function* truncatedTurn(text: string): Generator<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;
  yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
  yield {
    type: 'modelContentBlockDeltaEvent',
    delta: { type: 'textDelta', text },
  } as ModelStreamEvent;
  yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
  // (no modelMessageStopEvent — stream ends here)
}

/**
 * Minimal `Model` subclass. `streamAggregated()` is concrete on the base; we
 * only implement the abstract surface (`stream`, `getConfig`, `updateConfig`).
 *
 * `failuresBeforeSuccess` controls how many leading invocations truncate before
 * one completes. The agent loop re-invokes `stream()` once per attempt, so a
 * per-instance `attempts` counter yields deterministic fail-then-succeed
 * behavior across retries.
 */
class FakeModel extends Model {
  private config: BaseModelConfig = { modelId: 'fake-model' };
  /** Number of times `stream()` has been invoked on this instance. */
  attempts = 0;

  constructor(
    private readonly failuresBeforeSuccess: number,
    private readonly text = 'Hello',
  ) {
    super();
  }

  getConfig(): BaseModelConfig {
    return this.config;
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig };
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      yield* truncatedTurn(this.text);
      return;
    }
    yield* completeTurn(this.text);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Zero-delay strategy so retries don't introduce real wall-clock latency. */
function fixStrategy(maxAttempts = 3): StreamTerminationRetryStrategy {
  return new StreamTerminationRetryStrategy({
    maxAttempts,
    backoff: new ConstantBackoff({ delayMs: 0 }),
  });
}

/** Drain an agent stream to completion (throws propagate to the caller). */
async function drain(agent: Agent, prompt: string): Promise<void> {
  for await (const _event of agent.stream(prompt)) {
    void _event;
  }
}

function lastAssistantText(agent: Agent): string {
  const msgs = agent.messages;
  const last = msgs[msgs.length - 1];
  return last.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('');
}

// ---------------------------------------------------------------------------
// 1. Reproduction — the bug, isolated at the SDK base-class layer
// ---------------------------------------------------------------------------

describe('reproduction: stream ends without messageStop', () => {
  it('Model.streamAggregated throws the exact ModelError', async () => {
    const model = new FakeModel(Number.POSITIVE_INFINITY); // always truncates
    const messages = [new Message({ role: 'user', content: [new TextBlock('hi')] })];

    const run = async () => {
      // streamAggregated yields events then *returns* the final result; iterate
      // to drive it to the throw.
      for await (const _event of model.streamAggregated(messages)) {
        void _event;
      }
    };

    await expect(run()).rejects.toThrow(ModelError);
    await expect(run()).rejects.toThrow(STREAM_INCOMPLETE_MESSAGE);
  });

  it('Agent aborts the turn when retries are disabled (retryStrategy: null)', async () => {
    const model = new FakeModel(Number.POSITIVE_INFINITY);
    const agent = new Agent({ model, retryStrategy: null, printer: false });

    await expect(drain(agent, 'hi')).rejects.toThrow(STREAM_INCOMPLETE_MESSAGE);
  });

  it('the SDK default strategy does NOT recover (only retries throttling)', async () => {
    // No retryStrategy ⇒ SDK installs DefaultModelRetryStrategy, which retries
    // ModelThrottledError only. This is the shipped pre-fix behavior.
    const model = new FakeModel(1); // would succeed on attempt 2 if retried
    const agent = new Agent({ model, printer: false });

    await expect(drain(agent, 'hi')).rejects.toThrow(STREAM_INCOMPLETE_MESSAGE);
    expect(model.attempts).toBe(1); // never retried
  });
});

// ---------------------------------------------------------------------------
// 2. Fix — the custom strategy recovers a transient truncation
// ---------------------------------------------------------------------------

describe('fix: StreamTerminationRetryStrategy recovers', () => {
  it('retries a single transient truncation and completes the turn', async () => {
    const model = new FakeModel(1); // truncate once, then succeed
    const agent = new Agent({ model, retryStrategy: fixStrategy(), printer: false });

    await expect(drain(agent, 'hi')).resolves.toBeUndefined();

    expect(model.attempts).toBe(2); // failed once, retried once, succeeded
    expect(agent.messages[agent.messages.length - 1].role).toBe('assistant');
    expect(lastAssistantText(agent)).toContain('Hello');
  });

  it('gives up after maxAttempts and surfaces the original ModelError', async () => {
    const model = new FakeModel(Number.POSITIVE_INFINITY); // never succeeds
    const agent = new Agent({ model, retryStrategy: fixStrategy(3), printer: false });

    await expect(drain(agent, 'hi')).rejects.toThrow(STREAM_INCOMPLETE_MESSAGE);
    expect(model.attempts).toBe(3); // bounded — does not loop forever
  });
});

// ---------------------------------------------------------------------------
// 3. Predicate — isRetryable matches only the transient case
// ---------------------------------------------------------------------------

describe('StreamTerminationRetryStrategy.isRetryable', () => {
  const strategy = new StreamTerminationRetryStrategy();

  it('retries the transient mid-stream truncation ModelError', () => {
    expect(strategy.isRetryable(new ModelError(STREAM_INCOMPLETE_MESSAGE))).toBe(true);
  });

  it('preserves the inherited throttle-retry behavior', () => {
    expect(strategy.isRetryable(new ModelThrottledError('rate limited'))).toBe(true);
  });

  it('does NOT retry non-transient ModelError subclasses', () => {
    expect(strategy.isRetryable(new MaxTokensError('hit token ceiling'))).toBe(false);
    expect(strategy.isRetryable(new ContextWindowOverflowError('context too large'))).toBe(false);
  });

  it('does NOT retry a base ModelError with a different message', () => {
    // e.g. the SDK wrapping a deterministic JSON.parse SyntaxError as a base
    // ModelError carrying the original (non-matching) message.
    expect(strategy.isRetryable(new ModelError('Unexpected token < in JSON'))).toBe(false);
  });

  it('does NOT retry a plain Error', () => {
    expect(strategy.isRetryable(new Error(STREAM_INCOMPLETE_MESSAGE))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Observability: retry-count accounting + structured log events
// ---------------------------------------------------------------------------

describe('StreamTerminationRetryStrategy observability', () => {
  const truncation = () => new ModelError(STREAM_INCOMPLETE_MESSAGE);

  it('starts with retryCount 0 and exposes maxAttempts', () => {
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 3 });
    expect(s.retryCount).toBe(0);
    expect(s.maxAttempts).toBe(3);
  });

  it('increments retryCount only when an error is classified retryable', () => {
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 5 });

    // Non-retryable: counter must not move.
    s.isRetryable(new MaxTokensError('ceiling'));
    expect(s.retryCount).toBe(0);

    // Retryable transient truncation: counter advances by one each time.
    s.isRetryable(truncation());
    expect(s.retryCount).toBe(1);
    s.isRetryable(truncation());
    expect(s.retryCount).toBe(2);
  });

  it('counts inherited throttle retries as well', () => {
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 5 });
    s.isRetryable(new ModelThrottledError('rate limited'));
    expect(s.retryCount).toBe(1);
  });

  it('keeps returning true at the maxAttempts boundary (give-up is enforced by the SDK)', () => {
    // maxAttempts = 2 → the second classification is the exhaustion boundary.
    const s = new StreamTerminationRetryStrategy({ maxAttempts: 2 });
    expect(s.isRetryable(truncation())).toBe(true); // attempt 1: classified
    expect(s.retryCount).toBe(1);
    expect(s.isRetryable(truncation())).toBe(true); // attempt 2: exhausted (still true)
    expect(s.retryCount).toBe(2);
  });

  // NOTE: The structured-log *content* (stable `msg` keys, levels, and the
  // `attempt` / `maxAttempts` / `willRetry` / `kind` / `err` fields) is asserted
  // in `stream-termination-retry-strategy.logging.test.ts`, which mocks the
  // scoped logger via `jest.unstable_mockModule`. We deliberately do NOT capture
  // `process.stdout` here: pino's stdout writes are environment-dependent
  // (buffering / fd handling differs between local and CI), which made the
  // stdout-capture assertion flaky in CI.
});
