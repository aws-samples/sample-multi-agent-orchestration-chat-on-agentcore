/**
 * EventBridge Scheduler event handler
 * Triggered by EventBridge Scheduler to invoke Agent API
 */

import { SchedulerEvent, EventDrivenContext } from '../types/index.js';
import { parseTriggerId } from '@moca/core';
import { AuthService } from '../services/auth-service.js';
import { AgentInvoker } from '../services/agent-invoker.js';
import { ExecutionRecorder } from '../services/execution-recorder.js';
import { createAgentsService } from '../services/agents-service.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('ScheduleHandler');

/**
 * Lambda handler response
 */
export interface HandlerResponse {
  statusCode: number;
  body: string;
}

/**
 * Handle EventBridge Scheduler event
 */
export async function handleSchedulerEvent(event: SchedulerEvent): Promise<HandlerResponse> {
  log.info(
    {
      source: event.source,
      detailType: event['detail-type'],
      id: event.id,
    },
    'Received Scheduler event'
  );

  const payload = event.detail;
  const { triggerId: rawTriggerId, userId, agentId, prompt } = payload;

  if (!rawTriggerId || !userId || !agentId || !prompt) {
    // Avoid logging the raw payload — `prompt` is user-authored free text
    // and the wider payload could carry other sensitive fields.
    log.error(
      {
        hasTriggerId: !!rawTriggerId,
        hasUserId: !!userId,
        hasAgentId: !!agentId,
        hasPrompt: !!prompt,
      },
      'Invalid event payload'
    );
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields in event payload' }),
    };
  }

  // Validate triggerId format (runtime check — EventBridge payload is untyped JSON)
  let triggerId;
  try {
    triggerId = parseTriggerId(rawTriggerId);
  } catch {
    log.error({ rawTriggerId }, 'Invalid triggerId in event payload, discarding');
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid triggerId format in event payload' }),
    };
  }

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
    // Step 1: Get Machine User authentication token
    log.info('Obtaining Machine User token');
    const tokenResponse = await authService.getMachineUserToken();

    // Step 2: Obtain per-user OpenID Token so the Runtime can acquire Identity Pool
    // credentials scoped to the target user's S3 prefix and DynamoDB partition key.
    // Non-fatal: if this fails, the invocation proceeds without per-user credentials
    // (file/session operations inside the agent will fail, but the invocation itself
    // is still dispatched for observability and partial execution).
    let openIdToken: string | undefined;
    try {
      log.info({ userId }, 'Obtaining per-user OpenID Token');
      const oidcResponse = await authService.getOpenIdTokenForUser(userId);
      openIdToken = oidcResponse.openIdToken;
      log.info({ identityId: oidcResponse.identityId }, 'Per-user OpenID Token obtained');
    } catch (oidcError) {
      log.warn(
        { err: oidcError },
        'Failed to obtain per-user OpenID Token (non-fatal); agent will run without per-user storage access'
      );
    }

    // Step 3: Build event-driven context
    const eventContext: EventDrivenContext = {
      triggerId,
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
      eventDetail: payload as unknown as Record<string, unknown>,
    };

    log.info(
      {
        triggerId: eventContext.triggerId,
        source: eventContext.eventBridge.source,
        detailType: eventContext.eventBridge.detailType,
      },
      'Event context prepared'
    );

    // Step 4: Invoke Agent API with fire-and-forget (async)
    log.info('Invoking Agent API (async fire-and-forget)');
    const invocationResponse = await agentInvoker.invokeAsync(
      payload,
      tokenResponse.accessToken,
      eventContext,
      openIdToken
    );

    // Step 5: Record execution (success or failure)
    const executionId = await executionRecorder.recordExecution(
      triggerId,
      invocationResponse.sessionId,
      event,
      invocationResponse.success ? undefined : invocationResponse.error
    );

    // Step 6: Update trigger's last execution timestamp
    await executionRecorder.updateTriggerLastExecution(userId, triggerId);

    if (!invocationResponse.success) {
      log.error(
        { triggerId, executionId, error: invocationResponse.error },
        'Agent invocation failed'
      );

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Agent invocation failed',
          message: invocationResponse.error,
          executionId,
        }),
      };
    }

    log.info(
      { triggerId, executionId, sessionId: invocationResponse.sessionId },
      'Trigger invocation dispatched successfully (fire-and-forget)'
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        triggerId,
        executionId,
        sessionId: invocationResponse.sessionId,
      }),
    };
  } catch (error) {
    log.error({ err: error }, 'Unexpected error during trigger execution');

    // Record unexpected errors too
    try {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await executionRecorder.recordExecution(triggerId, undefined, event, errorMsg);
      await executionRecorder.updateTriggerLastExecution(userId, triggerId);
    } catch (recordError) {
      log.error({ err: recordError }, 'Failed to record execution error (non-critical)');
    }

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Unexpected error',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
