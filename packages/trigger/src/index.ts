/**
 * Lambda handler entry point for Trigger Lambda
 * Handles EventBridge Scheduler events and custom EventBridge events
 */

import { SchedulerEvent, CustomEventBridgeEvent } from './types/index.js';
import { handleSchedulerEvent } from './handlers/schedule-handler.js';
import { handleCustomEvent } from './handlers/custom-event-handler.js';
import { createLogger } from './libs/logger/index.js';

const log = createLogger('TriggerLambda');

/**
 * Type guard to check if event is a SchedulerEvent
 */
function isSchedulerEvent(event: unknown): event is SchedulerEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    e.source === 'aws.scheduler' ||
    e['detail-type'] === 'Scheduled Event' ||
    (typeof e.detail === 'object' &&
      e.detail !== null &&
      'triggerId' in (e.detail as Record<string, unknown>) &&
      'userId' in (e.detail as Record<string, unknown>))
  );
}

/**
 * Type guard to check if event is a CustomEventBridgeEvent
 */
function isCustomEvent(event: unknown): event is CustomEventBridgeEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    e.source !== undefined &&
    e['detail-type'] !== undefined &&
    e.source !== 'aws.scheduler' &&
    e['detail-type'] !== 'Scheduled Event'
  );
}

/**
 * AWS Lambda handler
 * Routes to appropriate handler based on event type
 */
export const handler = async (event: SchedulerEvent | CustomEventBridgeEvent) => {
  // Log only structural metadata. The `event.detail` payload may contain
  // third-party webhook bodies (GitHub, etc.) with PII, secrets, or tokens
  // in free-text fields that pino's key-based redact cannot catch.
  log.info(
    {
      source: event.source,
      detailType: event['detail-type'],
      id: event.id,
    },
    'Lambda invoked'
  );

  try {
    // Route based on event type
    if (isSchedulerEvent(event)) {
      log.info('Routing to Scheduler event handler');
      const response = await handleSchedulerEvent(event as SchedulerEvent);
      log.info({ response }, 'Handler response');
      return response;
    } else if (isCustomEvent(event)) {
      log.info('Routing to Custom event handler');
      const response = await handleCustomEvent(event as CustomEventBridgeEvent);
      log.info({ response }, 'Handler response');
      return response;
    } else {
      // Both type guards returned false — event has been narrowed to `never`
      // by TS, but at runtime it's still an unknown payload. Reach in with a
      // typed view for logging metadata only.
      const unknownEvent = event as { source?: unknown; 'detail-type'?: unknown; id?: unknown };
      log.error(
        {
          source: unknownEvent.source,
          detailType: unknownEvent['detail-type'],
          id: unknownEvent.id,
        },
        'Unknown event type'
      );
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Unknown event type',
          message: 'Event does not match any supported event type',
        }),
      };
    }
  } catch (error) {
    log.error({ err: error }, 'Unhandled error in Lambda handler');

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
};

// Export types and services for testing
export * from './types/index.js';
export * from './services/auth-service.js';
export * from './services/agent-invoker.js';
export * from './services/prompt-builder.js';
export * from './services/execution-recorder.js';
export * from './handlers/schedule-handler.js';
export * from './handlers/custom-event-handler.js';
