/**
 * Agent streaming response handler
 *
 * Manages the streaming lifecycle: headers, event loop, completion, and error handling.
 * Retrieves request-scoped information (requestId, actorId, sessionId) from RequestContext.
 */

import type { Response } from 'express';
import type { Agent } from '@strands-agents/sdk';
import { logger } from '../libs/logger/index.js';
import {
  createErrorMessage,
  sanitizeErrorMessage,
  serializeStreamEvent,
  buildInputContent,
} from '../libs/utils/index.js';
import { getCurrentContext, getContextMetadata } from '../libs/context/request-context.js';
import { registerAgent, unregisterAgent } from '../libs/health/agent-cancel-registry.js';
import type { SessionStorage, SessionConfig } from '../services/session/types.js';
import type { AgentMetadata } from '../runtime/agent/types.js';
import type { StreamTerminationRetryStrategy } from '../runtime/agent/stream-termination-retry-strategy.js';
import type { ImageData } from '../types/validation/index.js';

/**
 * Streaming-specific options (not duplicating what's in RequestContext)
 */
export interface StreamOptions {
  /** Agent creation metadata (included in completion event) */
  metadata: AgentMetadata;
  /**
   * Retry strategy wired into the agent. Read after a successful turn to emit
   * `stream_retry_recovered` when a transient mid-stream truncation was
   * retried and the turn ultimately succeeded. Optional so callers that don't
   * thread it through (e.g. some tests) still type-check.
   */
  retryStrategy?: StreamTerminationRetryStrategy;
  /** Session storage (for saving error messages on stream failure) */
  sessionStorage?: SessionStorage;
  /** Session config (for saving error messages on stream failure) */
  sessionConfig?: SessionConfig;
}

/**
 * Set streaming response headers on the Express response.
 */
function setStreamingHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
}

/**
 * Send a completion event with metadata.
 *
 * `type` is `serverCancelledEvent` when the turn was interrupted (client
 * disconnect / `agent.cancel()`), else `serverCompletionEvent`. Both carry the
 * same metadata shape so the frontend can settle the streaming message
 * identically; only the discriminator differs.
 */
function sendCompletionEvent(
  res: Response,
  agent: Agent,
  options: StreamOptions,
  cancelled = false
): void {
  const context = getCurrentContext();
  const contextMeta = getContextMetadata();
  const completionEvent = {
    type: cancelled ? 'serverCancelledEvent' : 'serverCompletionEvent',
    metadata: {
      requestId: context?.requestId,
      duration: contextMeta.duration,
      sessionId: context?.sessionId,
      actorId: context?.userId,
      conversationLength: agent.messages.length,
      agentMetadata: options.metadata,
    },
  };
  res.write(`${JSON.stringify(completionEvent)}\n`);
}

/**
 * Handle a streaming error: log, save to session history, and send error event.
 */
async function handleStreamError(
  error: unknown,
  res: Response,
  options: StreamOptions
): Promise<void> {
  const requestId = getCurrentContext()?.requestId;

  // Surface MaxTokensError explicitly so it is easily discoverable in CloudWatch
  // without having to inspect the full serialised error object.
  // We intentionally do NOT log error.cause here to prevent partialMessage
  // content from leaking into log streams.
  if (error instanceof Error && error.name === 'MaxTokensError') {
    logger.warn(
      {
        requestId,
        errorName: error.name,
      },
      'MaxTokensError: Bedrock max_tokens limit reached during streaming'
    );
  }

  // Log the full error. Use the `err` key (not `error`) so pino's configured
  // `err` serializer (libs/logger) expands name/message/stack/cause into
  // structured fields. The previous `{ requestId, error }` form bypassed that
  // serializer and emitted only `{"error":{"name":"ModelError"}}`, dropping
  // `message`/`stack`/`cause` — which made mid-stream truncation failures
  // indistinguishable in CloudWatch. `attempt`/`retried` correlate the failure
  // with the retry strategy's `stream_retry_classified`/`_exhausted` events.
  const retryCount = options.retryStrategy?.retryCount ?? 0;
  logger.error(
    {
      requestId,
      retried: retryCount > 0,
      attempts: retryCount > 0 ? retryCount + 1 : 1,
      err: error,
    },
    'Agent streaming error:'
  );

  // Save error message to session history if session is configured
  if (options.sessionStorage && options.sessionConfig) {
    try {
      const errorMessage = createErrorMessage(error, requestId || 'unknown');
      await options.sessionStorage.appendMessage(options.sessionConfig, errorMessage);
      logger.info(
        {
          requestId,
          sessionId: options.sessionConfig.sessionId,
        },
        'Error message saved to session history:'
      );
    } catch (saveError) {
      logger.error({ err: saveError }, 'Failed to save error message to session:');
    }
  }

  // Send error event to client
  const errorEvent = {
    type: 'serverErrorEvent',
    error: {
      message: sanitizeErrorMessage(error),
      requestId,
      savedToHistory: !!(options.sessionStorage && options.sessionConfig),
    },
  };
  res.write(`${JSON.stringify(errorEvent)}\n`);
  res.end();
}

/** Outcome of a streamed turn, returned to the handler for post-turn orchestration. */
export interface StreamResult {
  /** True when the turn stopped early via cancellation (client disconnect / cancel). */
  cancelled: boolean;
}

/**
 * Stream the agent response as NDJSON events.
 *
 * Handles the full lifecycle:
 * 1. Set streaming headers
 * 2. Stream events from agent
 * 3. Send completion metadata
 * 4. Handle errors (save to session + notify client)
 *
 * Returns a {@link StreamResult} so the caller can react to a cancelled turn
 * (e.g. propagate the cancel to sub-agent tasks) without this module needing to
 * know about that machinery.
 */
export async function streamAgentResponse(
  agent: Agent,
  prompt: string,
  images: ImageData[] | undefined,
  res: Response,
  options: StreamOptions
): Promise<StreamResult> {
  const context = getCurrentContext();
  const requestId = context?.requestId;
  const sessionId = context?.sessionId;
  setStreamingHeaders(res);

  // Register this turn's Agent so an out-of-band stop command can cancel it.
  //
  // WHY not client-disconnect: AgentCore Runtime does NOT propagate a client
  // fetch abort to the container (verified in production — no `res` 'close'
  // fires, the turn runs to completion). So cancellation is driven by a second
  // `{ action: 'stop' }` invocation that AgentCore's session-sticky routing
  // delivers to THIS microVM; stopDispatchMiddleware looks the Agent up in the
  // registry and calls `agent.cancel()`. That cooperatively stops the Strands
  // loop at its next checkpoint and the stream returns `stopReason: 'cancelled'`.
  //
  // Sessionless invocations (no sessionId) can't be targeted by a stop command,
  // so registration is skipped for them.
  if (sessionId) {
    registerAgent(sessionId, agent);
  }

  try {
    logger.info({ requestId }, 'Agent streaming started:');

    const agentInput = buildInputContent(prompt, images);

    // Stream events as NDJSON.
    //
    // Message persistence and AppSync Events publishing are handled centrally
    // by SessionPersistenceHook.onMessageAdded (for both stream and invoke modes).
    //
    // `serializeStreamEvent()` returns an array because SDK 1.x's
    // `modelStreamUpdateEvent` is unwrapped into the legacy inner-event
    // shape so the frontend handler can stay on the same wire protocol.
    // We emit one NDJSON line per element, preserving the loop's emission
    // order.
    //
    // Token usage attributes are written to the Strands SDK's own
    // `invoke_agent` span by the SDK; we deliberately don't mirror them
    // onto any wrapper span — AgentCore Observability's trace-level
    // aggregator only works when the canonical
    // `POST → invoke_agent → execute_event_loop_cycle → chat` hierarchy
    // is preserved.
    // Manual iteration (not `for await`) so we can read the generator's RETURN
    // value — the `AgentResult` carrying `stopReason`. `for await` discards it.
    // Cancellation is driven by `agent.cancel()` (from the stop command via the
    // registry), which fires the agent's own internal signal — no external
    // cancelSignal needed here.
    const stream = agent.stream(agentInput);
    let streamResult = await stream.next();
    while (!streamResult.done) {
      const safeEvents = serializeStreamEvent(streamResult.value);
      for (const safeEvent of safeEvents) {
        res.write(`${JSON.stringify(safeEvent)}\n`);
      }
      streamResult = await stream.next();
    }
    const agentResult = streamResult.value;
    const cancelled = agentResult?.stopReason === 'cancelled';

    // A cancelled turn is a normal, expected outcome — NOT an error. The SDK has
    // already left `agent.messages` in a reinvokable state (synthetic assistant /
    // tool-result blocks) and the SessionPersistenceHook's AfterInvocationEvent
    // has persisted it, so we neither write a serverErrorEvent nor save an error
    // message here. We just tell the client the turn stopped early.
    if (cancelled) {
      logger.info({ requestId }, 'Agent turn cancelled:');
      sendCompletionEvent(res, agent, options, true);
      res.end();
      // Signal the caller (handleInvocation) so it can propagate the cancel to
      // any sub-agent tasks this turn spawned. Sub-agent orchestration lives in
      // the handler, not here — keeping stream-handler free of that dependency
      // chain (and unit-testable in isolation).
      return { cancelled: true };
    }

    logger.info({ requestId }, 'Agent streaming completed:');

    // If the turn completed only after one or more transient mid-stream
    // truncations were retried, record the recovery. This is the *success*
    // counterpart to `stream_retry_classified` / `stream_retry_exhausted` and
    // is the only signal that lets operations compute a retry recovery rate
    // (recovered vs. exhausted) — a successful turn is otherwise silent.
    const retryCount = options.retryStrategy?.retryCount ?? 0;
    if (retryCount > 0) {
      logger.info(
        {
          requestId,
          attempts: retryCount + 1,
          retries: retryCount,
          recovered: true,
        },
        'stream_retry_recovered'
      );
    }

    sendCompletionEvent(res, agent, options);
    res.end();
    return { cancelled: false };
  } catch (streamError) {
    await handleStreamError(streamError, res, options);
    return { cancelled: false };
  } finally {
    // Always remove this turn's registration. Pass `agent` so we only evict our
    // own entry — a follow-up turn for the same session may have already
    // re-registered by the time this finally runs.
    if (sessionId) {
      unregisterAgent(sessionId, agent);
    }
  }
}
