/**
 * Custom Event Handler
 * Handles EventBridge custom events (S3, GitHub, Slack, etc.) using event subscription model
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { CustomEventBridgeEvent, EventDrivenContext, Trigger } from '../types/index.js';
import { AuthService } from '../services/auth-service.js';
import { AgentInvoker } from '../services/agent-invoker.js';
import { ExecutionRecorder } from '../services/execution-recorder.js';
import { createAgentsService } from '../services/agents-service.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('CustomEventHandler');
const dynamoClient = new DynamoDBClient({});

/**
 * Resolve eventSourceId from EventBridge event
 * The eventSourceId is injected by EventBridge Rule's InputTransformer
 */
function resolveEventSourceId(event: CustomEventBridgeEvent): string {
  // InputTransformer injects _eventSourceId from environments.ts eventRules config
  const injectedId = (event as unknown as { _eventSourceId?: string })._eventSourceId;

  if (injectedId) {
    log.info({ eventSourceId: injectedId }, 'eventSourceId resolved from InputTransformer');
    return injectedId;
  }

  // Fallback for direct invocations (testing, manual triggers, etc.)
  const source = event.source;
  log.warn({ source }, 'eventSourceId not found in event; using source as fallback');
  return source.replace(/\./g, '-');
}

/**
 * Find all triggers subscribed to the given eventSourceId (GSI2 query)
 */
async function findSubscribedTriggers(eventSourceId: string): Promise<Trigger[]> {
  const tableName = process.env.TRIGGERS_TABLE_NAME;
  if (!tableName) {
    throw new Error('TRIGGERS_TABLE_NAME environment variable not configured');
  }

  log.info({ eventSourceId }, 'Querying GSI2 for eventSourceId');

  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: '#enabled = :enabled',
      ExpressionAttributeNames: {
        '#enabled': 'enabled',
      },
      ExpressionAttributeValues: {
        ':pk': { S: `EVENTSOURCE#${eventSourceId}` },
        ':enabled': { BOOL: true },
      },
    })
  );

  if (!result.Items || result.Items.length === 0) {
    log.info({ eventSourceId }, 'No enabled triggers found for eventSourceId');
    return [];
  }

  const triggers = result.Items.map((item) => unmarshall(item) as Trigger);
  log.info({ count: triggers.length }, 'Found subscribed trigger(s)');
  return triggers;
}

/**
 * Invoke a single trigger with the event data
 */
async function invokeTrigger(
  trigger: Trigger,
  event: CustomEventBridgeEvent,
  authService: AuthService,
  agentInvoker: AgentInvoker,
  executionRecorder: ExecutionRecorder
): Promise<{ success: boolean; error?: string }> {
  try {
    log.info({ triggerId: trigger.id, triggerName: trigger.name }, 'Invoking trigger');

    // Get authentication token
    const tokenResponse = await authService.getMachineUserToken();

    // Obtain per-user OpenID Token so the Runtime can acquire Identity Pool credentials
    // scoped to the target user's S3 prefix and DynamoDB partition key.
    // Non-fatal: proceed without per-user credentials if this fails.
    let openIdToken: string | undefined;
    try {
      log.info({ userId: trigger.userId }, 'Obtaining per-user OpenID Token');
      const oidcResponse = await authService.getOpenIdTokenForUser(trigger.userId);
      openIdToken = oidcResponse.openIdToken;
      log.info(
        { identityId: oidcResponse.identityId },
        'Per-user OpenID Token obtained'
      );
    } catch (oidcError) {
      log.warn(
        { err: oidcError, triggerName: trigger.name },
        'Failed to obtain per-user OpenID Token for trigger (non-fatal)'
      );
    }

    // Build EventDrivenContext
    const context: EventDrivenContext = {
      triggerId: trigger.id,
      triggerName: trigger.name,
      executionTime: new Date().toISOString(),
      eventBridge: {
        id: event.id,
        source: event.source,
        detailType: event['detail-type'],
        account: event.account,
        region: event.region,
        time: event.time,
        resources: event.resources,
      },
      eventDetail: event.detail,
    };

    // Build payload for agent invocation
    const payload = {
      triggerId: trigger.id,
      userId: trigger.userId,
      agentId: trigger.agentId,
      prompt: trigger.prompt,
      sessionId: trigger.sessionId,
      modelId: trigger.modelId,
      workingDirectory: trigger.workingDirectory,
      enabledTools: trigger.enabledTools,
    };

    // Invoke agent (async fire-and-forget)
    const result = await agentInvoker.invokeAsync(
      payload,
      tokenResponse.accessToken,
      context,
      openIdToken
    );

    // Record execution (success or failure)
    await executionRecorder.recordExecution(
      trigger.id,
      result.sessionId,
      event,
      result.success ? undefined : result.error
    );

    // Update trigger's last execution timestamp
    await executionRecorder.updateTriggerLastExecution(trigger.userId, trigger.id);

    if (!result.success) {
      log.error(
        { triggerName: trigger.name, error: result.error },
        'Agent invocation failed for trigger'
      );
      return { success: false, error: result.error };
    }

    log.info({ triggerName: trigger.name }, 'Trigger invocation dispatched (fire-and-forget)');
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ err: error, triggerName: trigger.name }, 'Trigger invocation failed');

    // Record unexpected errors too
    try {
      await executionRecorder.recordExecution(trigger.id, undefined, event, errorMessage);
      await executionRecorder.updateTriggerLastExecution(trigger.userId, trigger.id);
    } catch (recordError) {
      log.error({ err: recordError }, 'Failed to record execution error (non-critical)');
    }

    return { success: false, error: errorMessage };
  }
}

/**
 * Main custom event handler
 */
export async function handleCustomEvent(event: CustomEventBridgeEvent) {
  // The `event.detail` from third-party sources (GitHub webhooks, etc.) may
  // contain PII or tokens embedded in free-text fields (commit messages,
  // issue bodies) that pino's key-based redact cannot scrub. Log structural
  // metadata only.
  log.info(
    {
      source: event.source,
      detailType: event['detail-type'],
      id: event.id,
      resources: event.resources,
    },
    'Custom event received'
  );

  // Initialize services
  let authService: AuthService;
  let agentInvoker: AgentInvoker;
  let executionRecorder: ExecutionRecorder;

  try {
    authService = AuthService.fromEnvironment();
    const agentsService = createAgentsService();
    agentInvoker = AgentInvoker.fromEnvironment(agentsService);
    executionRecorder = ExecutionRecorder.fromEnvironment();
  } catch (error) {
    log.error({ err: error }, 'Failed to initialize services');
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Service initialization failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  try {
    // 1. Resolve eventSourceId from event
    const eventSourceId = resolveEventSourceId(event);
    log.info({ eventSourceId }, 'Resolved eventSourceId');

    // 2. Find all subscribed triggers (GSI2 query)
    const triggers = await findSubscribedTriggers(eventSourceId);

    if (triggers.length === 0) {
      log.info({ eventSourceId }, 'No subscribed triggers found for eventSourceId');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No triggers subscribed to this event source',
          eventSourceId,
          eventSource: event.source,
          eventDetailType: event['detail-type'],
        }),
      };
    }

    // 3. Invoke all subscribed triggers
    log.info({ count: triggers.length }, 'Invoking trigger(s)');
    const results = await Promise.allSettled(
      triggers.map((trigger) =>
        invokeTrigger(trigger, event, authService, agentInvoker, executionRecorder)
      )
    );

    // 4. Summarize results
    const summary = {
      total: triggers.length,
      successful: results.filter((r) => r.status === 'fulfilled' && r.value.success).length,
      failed: results.filter(
        (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)
      ).length,
    };

    log.info({ summary }, 'Execution summary');

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Event processed successfully',
        eventSourceId,
        eventSource: event.source,
        eventDetailType: event['detail-type'],
        summary,
      }),
    };
  } catch (error) {
    log.error({ err: error }, 'Custom event handler error');

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
