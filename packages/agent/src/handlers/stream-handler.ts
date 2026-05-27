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
  classifyStreamError,
} from '../libs/utils/index.js';
import { getCurrentContext, getContextMetadata } from '../libs/context/request-context.js';
import type { SessionStorage, SessionConfig } from '../services/session/types.js';
import type { AgentMetadata } from '../runtime/agent/types.js';
import type { ImageData } from '../types/validation/index.js';

/**
 * Streaming-specific options (not duplicating what's in RequestContext)
 */
export interface StreamOptions {
  /** Agent creation metadata (included in completion event) */
  metadata: AgentMetadata;
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

  // Promote transient stream-cuts to a dedicated error class so observability
  // and the wire event downstream can distinguish them from genuine model
  // failures (validation, MaxTokensError, throttling).
  const classified = classifyStreamError(error);

  // Surface MaxTokensError explicitly so it is easily discoverable in CloudWatch
  // without having to inspect the full serialised error object.
  // We intentionally do NOT log error.cause here to prevent partialMessage
  // content from leaking into log streams.
  if (classified instanceof Error && classified.name === 'MaxTokensError') {
    logger.warn(
      {
        requestId,
        errorName: classified.name,
      },
      'MaxTokensError: Bedrock max_tokens limit reached during streaming'
    );
  }

  // Log under the `err` key so pino's `stdSerializers.err` (registered in
  // libs/logger) captures `name`, `message`, `stack`, and `cause` fields.
  // Logging under `error` would cause Error to be serialised as a plain
  // object whose non-enumerable `message`/`stack` properties are dropped —
  // which produced the empty `{"error":{"name":"ModelError"}}` log entries
  // seen in issue #8.
  logger.error(
    {
      requestId,
      err: classified,
      // AWS SDK v3 errors carry useful diagnostic metadata under $metadata
      // (httpStatusCode, requestId, cfId, attempts, totalRetryDelay).
      // Surface them as a top-level field for CloudWatch Logs Insights.
      awsMetadata:
        classified instanceof Error && '$metadata' in classified
          ? (classified as { $metadata?: unknown }).$metadata
          : undefined,
    },
    'Agent streaming error:'
  );

  // Save error message to session history if session is configured
  if (options.sessionStorage && options.sessionConfig) {
    try {
      const errorMessage = createErrorMessage(classified, requestId || 'unknown');
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

  // Send error event to client.
  // `errorName` and `isRetryable` are additive fields — the frontend's Zod
  // schema for `serverErrorEvent` uses `.passthrough()` so older clients
  // simply ignore them while newer clients can branch on the classification
  // (e.g. show a "Reconnect" button for StreamInterruptedError).
  const errorName = classified instanceof Error ? classified.name : 'UnknownError';
  const isRetryable =
    classified instanceof Error && (classified as { isRetryable?: boolean }).isRetryable === true;
  const errorEvent = {
    type: 'serverErrorEvent',
    error: {
      message: sanitizeErrorMessage(classified),
      errorName,
      isRetryable,
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

    sendCompletionEvent(res, agent, options);
    res.end();
  } catch (streamError) {
    await handleStreamError(streamError, res, options);
  }
}
