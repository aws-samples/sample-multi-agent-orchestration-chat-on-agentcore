/**
 * Streaming event serialization for Strands Agents
 * Safely serialize streaming events by extracting only necessary properties
 * from objects containing circular references
 */

import { logger } from '../logger/index.js';
/**
 * Safely serialize Strands Agents streaming events
 * Extract only necessary properties from objects containing circular references
 */
export function serializeStreamEvent(event: unknown): object {
  const eventObj = event as { type?: string; [key: string]: unknown };
  const baseEvent = { type: eventObj.type };

  switch (eventObj.type) {
    // Text generation events
    case 'modelContentBlockDeltaEvent':
      return {
        ...baseEvent,
        delta: eventObj.delta,
      };

    case 'modelContentBlockStartEvent':
      return {
        ...baseEvent,
        start: eventObj.start,
      };

    case 'modelContentBlockStopEvent':
      return {
        ...baseEvent,
        stop: eventObj.stop,
      };

    // Message lifecycle events
    case 'modelMessageStartEvent':
      return {
        ...baseEvent,
        message: eventObj.message
          ? {
              role: (eventObj.message as { role: unknown }).role,
              content: (eventObj.message as { content: unknown }).content,
            }
          : undefined,
      };

    case 'modelMessageStopEvent':
      return {
        ...baseEvent,
        message: eventObj.message
          ? {
              role: (eventObj.message as { role: unknown }).role,
              content: (eventObj.message as { content: unknown }).content,
            }
          : undefined,
      };

    case 'messageAddedEvent':
      return {
        ...baseEvent,
        message: eventObj.message
          ? {
              role: (eventObj.message as { role: unknown }).role,
              content: (eventObj.message as { content: unknown }).content,
            }
          : undefined,
      };

    // Metadata and result events
    case 'modelMetadataEvent':
      // Log cache metrics
      if (eventObj.usage) {
        const usage = eventObj.usage as {
          inputTokens?: number;
          outputTokens?: number;
          cacheWriteInputTokens?: number;
          cacheReadInputTokens?: number;
        };

        if (usage.cacheWriteInputTokens || usage.cacheReadInputTokens) {
          logger.info(
            {
              cacheWriteInputTokens: usage.cacheWriteInputTokens || 0,
              cacheReadInputTokens: usage.cacheReadInputTokens || 0,
              inputTokens: usage.inputTokens || 0,
              outputTokens: usage.outputTokens || 0,
            },
            'Cache metrics'
          );
        }
      }
      return {
        ...baseEvent,
        usage: eventObj.usage,
      };

    case 'agentResult':
      return {
        ...baseEvent,
        result: eventObj.result,
      };

    // Text block events
    case 'textBlock':
      return {
        ...baseEvent,
        text: eventObj.text,
      };

    // Stream hook events (lightweight due to frequent occurrence)
    case 'modelStreamEventHook':
      return {
        ...baseEvent,
        // Hook information generally unnecessary, only type
      };

    // Existing lifecycle events
    case 'beforeInvocationEvent':
    case 'afterInvocationEvent':
    case 'afterToolsEvent':
    case 'beforeModelCallEvent':
      return baseEvent;

    case 'beforeToolsEvent':
      return {
        ...baseEvent,
        message: eventObj.message
          ? {
              role: (eventObj.message as { role: unknown }).role,
              content: (eventObj.message as { content: unknown }).content,
            }
          : undefined,
      };

    case 'afterModelCallEvent':
      return {
        ...baseEvent,
        stopReason: eventObj.stopReason,
        stopData: eventObj.stopData
          ? {
              message: (eventObj.stopData as { message: unknown }).message,
            }
          : undefined,
      };

    default:
      // Show warning only for truly unknown event types
      logger.warn({ type: eventObj.type }, 'New unknown streaming event:');
      return baseEvent;
  }
}
