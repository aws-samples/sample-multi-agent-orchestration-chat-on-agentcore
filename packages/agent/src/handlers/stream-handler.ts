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

  logger.error({ requestId, error }, 'Agent streaming error:');

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

    // Stream events as NDJSON
    // Message persistence and AppSync Events publishing are handled centrally
    // by SessionPersistenceHook.onMessageAdded (for both stream and invoke modes)
    for await (const event of agent.stream(agentInput)) {
      const safeEvent = serializeStreamEvent(event);
      res.write(`${JSON.stringify(safeEvent)}\n`);
    }

    logger.info({ requestId }, 'Agent streaming completed:');

    sendCompletionEvent(res, agent, options);
    res.end();
  } catch (streamError) {
    await handleStreamError(streamError, res, options);
  }
}
