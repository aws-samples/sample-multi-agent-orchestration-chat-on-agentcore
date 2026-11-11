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
import type { SessionStorage, SessionConfig } from '../services/session/types.js';
import type { AgentMetadata } from '../runtime/agent/types.js';
import type { StreamTerminationRetryStrategy } from '../runtime/agent/stream-termination-retry-strategy.js';
import type { ImageData } from '../types/validation/index.js';
import { LOG_CONTENT_ENABLED, summarizeContent } from '../libs/logger/mask-secrets.js';

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
 * A tool call can run for minutes without a single stream event. Some hop
 * between the browser and the Runtime drops such an idle response (observed
 * as `network error` during a 5-min `sleep`), while the turn keeps running
 * server-side. A periodic no-op event keeps bytes flowing.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Stop reasons that end the turn without an answer and without an error. The
 * SDK finishes the loop silently, so the user would otherwise only see a
 * truncated reasoning block.
 */
const USER_VISIBLE_STOP_REASONS = new Set(['contentFiltered', 'guardrailIntervened', 'refusal']);

/**
 * Per-stream accumulator for content logging (LOG_CONTENT=true only).
 *
 * The SDK emits text / reasoning as a series of delta events followed by a
 * block-stop event. We buffer deltas and flush them as a single log entry on
 * stop so CloudWatch doesn't receive hundreds of individual tiny lines.
 *
 * Tool input deltas (`toolUseInputDelta`) are intentionally NOT buffered:
 * they may contain user-supplied secrets (file contents, passwords, etc.)
 * that static regex patterns cannot reliably cover.
 */
interface StreamLogState {
  textBuffer: string;
  reasoningBuffer: string;
}

/**
 * Process one SDK stream event for structured content logging.
 *
 * No-op when `LOG_CONTENT_ENABLED` is false (the production default).
 * When enabled, accumulates text/reasoning deltas and logs a masked summary
 * on each block stop. Tool names are logged immediately on block start.
 */
function processEventForContentLog(event: unknown, state: StreamLogState): void {
  if (!LOG_CONTENT_ENABLED) return;

  const ev = event as {
    type?: string;
    delta?: { type?: string; text?: string };
    start?: { type?: string; name?: string };
  };

  switch (ev.type) {
    case 'modelContentBlockDeltaEvent': {
      const deltaType = ev.delta?.type;
      if (deltaType === 'textDelta') {
        state.textBuffer += ev.delta?.text ?? '';
      } else if (deltaType === 'reasoningContentDelta') {
        state.reasoningBuffer += ev.delta?.text ?? '';
      }
      // toolUseInputDelta: intentionally not logged — may contain secrets
      break;
    }
    case 'modelContentBlockStopEvent': {
      if (state.textBuffer) {
        logger.info(summarizeContent(state.textBuffer, 'streamText'), 'Stream text block:');
        state.textBuffer = '';
      }
      if (state.reasoningBuffer) {
        logger.info(
          summarizeContent(state.reasoningBuffer, 'reasoning'),
          'Stream reasoning block:'
        );
        state.reasoningBuffer = '';
      }
      break;
    }
    case 'modelContentBlockStartEvent': {
      if (ev.start?.type === 'toolUseStart' && ev.start.name) {
        logger.info({ toolName: ev.start.name }, 'Tool use started:');
      }
      break;
    }
  }
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
  const completionEvent = {
    type: 'serverCompletionEvent',
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
  const context = getCurrentContext();
  const requestId = context?.requestId;
  setStreamingHeaders(res);

  const writeEvent = (event: Record<string, unknown>): void => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  if (context) context.emitClientEvent = writeEvent;
  const heartbeat = setInterval(
    () => writeEvent({ type: 'serverHeartbeatEvent' }),
    HEARTBEAT_INTERVAL_MS
  );

  try {
    logger.info({ requestId }, 'Agent streaming started:');

    const agentInput = buildInputContent(prompt, images);

    // Per-stream state for content logging (LOG_CONTENT=true only).
    const contentLogState: StreamLogState = { textBuffer: '', reasoningBuffer: '' };

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
      processEventForContentLog(event, contentLogState);
      const stopReason =
        (event as { type?: string; result?: { stopReason?: string } }).type === 'agentResultEvent'
          ? (event as { result?: { stopReason?: string } }).result?.stopReason
          : undefined;
      if (stopReason && USER_VISIBLE_STOP_REASONS.has(stopReason)) {
        logger.warn({ requestId, stopReason }, 'Turn ended by the model without an answer');
        writeEvent({
          type: 'serverWarningEvent',
          warning: {
            code: 'modelStopped',
            stopReason,
            message: 'The model stopped this response (e.g. a safety filter).',
          },
        });
      }
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
  } finally {
    clearInterval(heartbeat);
    if (context) context.emitClientEvent = undefined;
  }
}
