/**
 * Agent streaming response handler
 *
 * Manages the streaming lifecycle: headers, event loop, completion, and error handling.
 * Retrieves request-scoped information (requestId, actorId, sessionId) from RequestContext.
 */

import type { Response } from 'express';
import type { Agent } from '@strands-agents/sdk';
import type { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal';
import { logger } from '../libs/logger/index.js';
import {
  createErrorMessage,
  sanitizeErrorMessage,
  serializeStreamEvent,
  buildInputContent,
} from '../libs/utils/index.js';
import { getCurrentContext, getContextMetadata } from '../libs/context/request-context.js';
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
  /**
   * GoalLoop plugin attached to this turn's agent, when a goal was supplied.
   * Read after the stream completes to surface `{ passed, stopReason, attempts }`
   * in the completion event metadata. Undefined for non-goal turns.
   */
  goalLoop?: GoalLoop;
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
 */
function sendCompletionEvent(res: Response, agent: Agent, options: StreamOptions): void {
  const context = getCurrentContext();
  const contextMeta = getContextMetadata();
  // Surface the GoalLoop outcome (if this turn ran under a goal) as a compact
  // summary. Per-attempt feedback text is intentionally NOT streamed — only the
  // pass flag, stop reason, and attempt count, which the UI turns into a
  // "refined N times" note.
  const goalResult = options.goalLoop?.lastResult(agent);
  const completionEvent = {
    type: 'serverCompletionEvent',
    metadata: {
      requestId: context?.requestId,
      duration: contextMeta.duration,
      sessionId: context?.sessionId,
      actorId: context?.userId,
      conversationLength: agent.messages.length,
      agentMetadata: options.metadata,
      ...(goalResult
        ? {
            goalResult: {
              passed: goalResult.passed,
              stopReason: goalResult.stopReason,
              attempts: goalResult.attempts.length,
            },
          }
        : {}),
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

/**
 * Stream the agent response as NDJSON events.
 *
 * Handles the full lifecycle:
 * 1. Set streaming headers
 * 2. Stream events from agent
 * 3. Send completion metadata
 * 4. Handle errors (save to session + notify client)
 */
export async function streamAgentResponse(
  agent: Agent,
  prompt: string,
  images: ImageData[] | undefined,
  res: Response,
  options: StreamOptions
): Promise<void> {
  const requestId = getCurrentContext()?.requestId;
  setStreamingHeaders(res);

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
    for await (const event of agent.stream(agentInput)) {
      const safeEvents = serializeStreamEvent(event);
      for (const safeEvent of safeEvents) {
        res.write(`${JSON.stringify(safeEvent)}\n`);
      }
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
  } catch (streamError) {
    await handleStreamError(streamError, res, options);
  }
}
