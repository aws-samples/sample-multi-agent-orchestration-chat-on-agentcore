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
   * Default to 3 total attempts (SDK default is 6). A transient truncation that
   * survives two re-issues is unlikely to be transient, and bounding attempts
   * caps token/latency cost on a genuinely stuck stream.
   */
  constructor(opts: DefaultModelRetryStrategyOptions = {}) {
    super({ maxAttempts: 3, ...opts });
  }

  override isRetryable(error: Error): boolean {
    // Preserve the inherited throttle-retry behavior.
    if (super.isRetryable(error)) {
      return true;
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
    return (
      error instanceof ModelError &&
      error.constructor === ModelError &&
      error.message === STREAM_INCOMPLETE_MESSAGE
    );
  }
}
