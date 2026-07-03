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
import type { WorkspaceSyncStatus } from '../types/workspace-sync-types.js';
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
 * How long the initial workspace pull must still be running before we tell the
 * user about it. Fast pulls (small workspaces, or already cached) finish inside
 * this window and stay silent, so the chat never flashes a "syncing" line that
 * vanishes a frame later.
 */
const WORKSPACE_SYNC_NOTIFY_DELAY_MS = 400;

/**
 * Surface the request's workspace initial-pull progress as `workspaceSyncEvent`
 * NDJSON lines, interleaved with the model stream on the same response.
 *
 * WHY on the model stream (not AppSync): the pull is kicked off per-invocation
 * and blocks the first file-touching tool within *this* turn, so its lifetime is
 * bounded by the stream the frontend is already reading. Reusing that channel
 * avoids standing up a second delivery path for a turn-scoped signal.
 *
 * Emission rules:
 * - Nothing is written until the pull has run for {@link WORKSPACE_SYNC_NOTIFY_DELAY_MS}
 *   (debounce against flashing on fast syncs).
 * - Once the "syncing" line is emitted, subsequent progress updates stream live
 *   and a terminal "complete" is sent.
 * - A pull that finishes (or was already finished) before the debounce elapses
 *   stays completely silent.
 * - Errors always surface regardless of timing — a silent failed sync is worse
 *   than a brief flash, because the agent may then operate on a stale workspace.
 *
 * @returns a cleanup function that unsubscribes and clears the debounce timer.
 */
function streamWorkspaceSyncStatus(res: Response): () => void {
  const workspaceSync = getCurrentContext()?.workspaceSync;
  if (!workspaceSync) return () => {};

  let hasEmitted = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatus: WorkspaceSyncStatus = workspaceSync.getStatus();

  const write = (payload: Record<string, unknown>): void => {
    res.write(`${JSON.stringify({ type: 'workspaceSyncEvent', ...payload })}\n`);
  };

  const emitFor = (status: WorkspaceSyncStatus): void => {
    if (status.phase === 'syncing') {
      hasEmitted = true;
      write({
        status: 'syncing',
        current: status.progress.current,
        total: status.progress.total,
        percentage: status.progress.percentage,
        currentFile: status.progress.currentFile,
      });
    } else if (status.phase === 'complete') {
      // Only announce completion if we announced the start; otherwise this was a
      // fast sync the user never saw begin.
      if (hasEmitted) write({ status: 'complete' });
    } else if (status.phase === 'error') {
      write({ status: 'error', message: status.message });
    }
  };

  const unsubscribe = workspaceSync.onStatusChange((status) => {
    lastStatus = status;

    if (status.phase === 'idle') return;

    if (status.phase === 'complete' || status.phase === 'error') {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      emitFor(status);
      return;
    }

    // phase === 'syncing'
    if (hasEmitted) {
      emitFor(status); // live progress after the initial announcement
      return;
    }
    // Arm the debounce exactly once; when it fires, announce only if still syncing.
    if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (lastStatus.phase === 'syncing') emitFor(lastStatus);
      }, WORKSPACE_SYNC_NOTIFY_DELAY_MS);
    }
  });

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    unsubscribe();
  };
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
  const requestId = getCurrentContext()?.requestId;
  setStreamingHeaders(res);

  // Interleave workspace initial-pull progress onto this stream. Started before
  // the model loop so a slow pull that blocks the first tool is reported while
  // the user waits. No-op when the request has no workspace sync.
  const stopWorkspaceSyncStatus = streamWorkspaceSyncStatus(res);

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
  } finally {
    // Detach the workspace-sync listener and clear any pending debounce timer.
    // Runs after res.end() in both paths — cleanup only, never writes.
    stopWorkspaceSyncStatus();
  }
}
