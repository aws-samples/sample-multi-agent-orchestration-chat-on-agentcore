/**
 * Retry strategy for transient mid-stream termination.
 *
 * Bedrock's ConverseStream occasionally closes the HTTP/2 event stream cleanly
 * (normal end-of-iteration, no thrown error) *before* delivering a `messageStop`
 * chunk — typically when an upstream LB / AgentCore gateway truncates a partial
 * response, or an idle connection is closed between chunks. When that happens,
 * the Strands SDK's `Model.streamAggregated()` finishes its loop with no
 * `finalStopReason` and throws a base `ModelError('Stream ended without
 * completing a message')` (see @strands-agents/sdk model.js).
 *
 * The agent event loop only retries a model call when a retry strategy sets
 * `AfterModelCallEvent.retry`. The SDK default (`DefaultModelRetryStrategy`)
 * retries `ModelThrottledError` ONLY, so this transient truncation propagates
 * out of `agent.stream()`, the handler persists a `[SYSTEM_ERROR]` assistant
 * message, and the agent stops mid-task — the reported symptom.
 *
 * WHY NOT bump the Bedrock client's `maxAttempts`: the AWS SDK retry middleware
 * wraps only the `send()` promise, which resolves once response headers arrive —
 * before any stream chunk is consumed. A failure while iterating the event
 * stream is outside that middleware and gets zero SDK-level retries. The retry
 * therefore has to live at the agent layer, re-issuing the whole model call.
 */

import {
  DefaultModelRetryStrategy,
  ModelError,
  MaxTokensError,
  ContextWindowOverflowError,
  type DefaultModelRetryStrategyOptions,
} from '@strands-agents/sdk';
import { createLogger } from '../../libs/logger/index.js';
import { getCurrentContext } from '../../libs/context/request-context.js';

const log = createLogger('StreamTerminationRetryStrategy');

/**
 * Classification of why `isRetryable` decided to retry. Surfaced on the
 * `stream_retry_*` log events so CloudWatch Logs Insights can split
 * `stats count() by kind` and distinguish a genuine mid-stream truncation
 * (the bug this strategy targets) from an inherited throttle retry.
 */
type RetryKind = 'stream_truncation' | 'throttle';

/**
 * The exact message thrown by the SDK base `Model.streamAggregated()` when the
 * stream ends without a `messageStop`. This literal is the only stable
 * discriminator — there is no dedicated error subclass — so the match is
 * deliberately anchored on it. Pinned to @strands-agents/sdk@1.2.x; if a future
 * SDK reworks this string the predicate stops matching and we fail *closed*
 * (revert to abort), never over-retry. The unit test on `isRetryable` is the
 * tripwire for that upgrade.
 */
export const STREAM_INCOMPLETE_MESSAGE = 'Stream ended without completing a message';

/**
 * Retries the transient mid-stream truncation `ModelError` in addition to the
 * SDK default (`ModelThrottledError`). Inherits the default bounded-attempts +
 * exponential-backoff machinery; only the retryable-classification is widened.
 *
 * `isRetryable` is intentionally `public` (the base declares it `protected`) so
 * the predicate can be unit-tested directly without driving a full agent loop.
 */
export class StreamTerminationRetryStrategy extends DefaultModelRetryStrategy {
  override readonly name = 'moca:stream-termination-retry-strategy';

  /**
   * Total attempts allowed before giving up (1 = no retry). Retained so the
   * strategy can log `maxAttempts` and detect the give-up boundary itself —
   * the base class keeps this private.
   */
  readonly maxAttempts: number;

  /**
   * Number of times this strategy has classified an error as retryable for
   * the current turn (i.e. how many model re-issues it has requested).
   *
   * - `0`  → the turn never hit a retryable failure.
   * - `>0` → at least one retry was requested; the stream handler reads this
   *   after a *successful* turn to emit `stream_retry_recovered`.
   *
   * `public readonly` so callers (and tests) can observe it without driving
   * the full agent loop. A fresh strategy instance is created per agent
   * (see agent.ts), so this counter is scoped to a single turn and must not
   * be reset or shared across agents.
   */
  retryCount = 0;

  /**
   * Default to 3 total attempts (SDK default is 6). A transient truncation that
   * survives two re-issues is unlikely to be transient, and bounding attempts
   * caps token/latency cost on a genuinely stuck stream.
   */
  constructor(opts: DefaultModelRetryStrategyOptions = {}) {
    const resolved = { maxAttempts: 3, ...opts };
    super(resolved);
    this.maxAttempts = resolved.maxAttempts;
  }

  override isRetryable(error: Error): boolean {
    // Preserve the inherited throttle-retry behavior.
    if (super.isRetryable(error)) {
      return this.recordRetry(error, 'throttle');
    }

    // Never retry deterministic, non-transient model errors. These are all
    // `ModelError` subclasses, so they must be excluded BEFORE the base-class
    // check below — retrying them would just burn tokens and loop:
    //   - MaxTokensError: output hit the token ceiling; needs intervention.
    //   - ContextWindowOverflowError: input too large; needs trimming.
    if (error instanceof MaxTokensError || error instanceof ContextWindowOverflowError) {
      return false;
    }

    // Match ONLY the base-class transient truncation. The `constructor` check
    // excludes any other ModelError subclass, and the exact-message check
    // excludes a base ModelError that merely *wraps* a deterministic failure
    // (model.js wraps non-ModelError stream errors — e.g. a JSON.parse
    // SyntaxError — as a base ModelError carrying the original message).
    const isTransientTruncation =
      error instanceof ModelError &&
      error.constructor === ModelError &&
      error.message === STREAM_INCOMPLETE_MESSAGE;

    if (isTransientTruncation) {
      return this.recordRetry(error, 'stream_truncation');
    }

    return false;
  }

  /**
   * Record a retry decision and emit the matching structured log event, then
   * return `true` (always retryable at the point this is called).
   *
   * Emits exactly one of:
   *   - `stream_retry_classified` (warn) — a retry is being requested; the
   *     turn will re-issue the model call. `willRetry: true`.
   *   - `stream_retry_exhausted`  (error) — this decision hit `maxAttempts`,
   *     so although the error *is* retryable the agent loop will abort after
   *     this. `willRetry: false`. This is the signal that distinguishes
   *     "retried and still failed" from "never matched / non-retryable".
   *
   * Fields (stable, numeric where applicable) are chosen for Logs Insights:
   *   attempt, maxAttempts, willRetry, kind, err{name,message}, requestId.
   */
  private recordRetry(error: Error, kind: RetryKind): boolean {
    this.retryCount += 1;
    // `attempt` is the model call that just failed (1-based): the first
    // failure is attempt 1, and we are about to issue attempt 2, etc.
    const attempt = this.retryCount;
    const exhausted = attempt >= this.maxAttempts;
    const errInfo = { name: error.name, message: error.message };

    if (exhausted) {
      log.error(
        {
          requestId: this.currentRequestId(),
          attempt,
          maxAttempts: this.maxAttempts,
          willRetry: false,
          kind,
          err: errInfo,
        },
        'stream_retry_exhausted'
      );
      // NOTE: we still return true so the base machinery keeps its accounting
      // consistent; the SDK enforces `maxAttempts` and stops re-issuing. The
      // `stream_retry_exhausted` log above is the authoritative give-up signal.
      return true;
    }

    log.warn(
      {
        requestId: this.currentRequestId(),
        attempt,
        maxAttempts: this.maxAttempts,
        willRetry: true,
        kind,
        err: errInfo,
      },
      'stream_retry_classified'
    );
    return true;
  }

  /**
   * Best-effort request correlation. The strategy runs inside the request's
   * `AsyncLocalStorage` context (the same context the stream handler reads),
   * so `getCurrentContext()` returns the in-flight request. Returns
   * `undefined` rather than throwing when no request is in flight (e.g. unit
   * tests that drive the strategy directly), so a missing context never
   * breaks retry classification.
   */
  private currentRequestId(): string | undefined {
    return getCurrentContext()?.requestId;
  }
}
