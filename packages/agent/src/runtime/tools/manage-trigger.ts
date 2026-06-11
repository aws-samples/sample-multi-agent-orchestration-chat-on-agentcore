/**
 * Manage Trigger Tool
 * Create, update, retrieve, or list schedule triggers.
 *
 * Backed entirely by the existing Backend `/triggers` endpoints; this tool
 * performs no direct AWS/DynamoDB access. Creating a schedule trigger provisions
 * a backing EventBridge Schedule on the Backend side (cron/rate validation,
 * 10-minute minimum interval, scheduler ARN persistence).
 *
 * Safety note: the Backend `POST /triggers` creates triggers with
 * `enabled: true`. To keep agent-created triggers inert until a human reviews
 * them, `handleCreate` immediately calls `POST /triggers/:id/disable` after a
 * successful create so the returned trigger is always `enabled: false`. The
 * tool deliberately exposes no enable/disable/delete action to the model.
 */

import { tool } from '@strands-agents/sdk';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import { getCurrentContext } from '../../libs/context/request-context.js';
import { manageTriggerDefinition } from '@moca/tool-definitions';

/**
 * Build request headers for backend API calls.
 *
 * Forwards the Cognito ID Token from the current RequestContext as
 * X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token because the Backend
 * `authMiddleware` requires it to resolve the Identity Pool identityId.
 *
 * Automatically includes X-Target-User-Id when running as a machine user
 * (e.g. EventBridge Scheduler triggered execution).
 */
function buildRequestHeaders(authHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };
  const context = getCurrentContext();
  if (context?.idToken) {
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'] = context.idToken;
  }
  if (context?.userId) {
    headers['X-Target-User-Id'] = context.userId;
  }
  return headers;
}

interface TriggerPayload {
  id: string;
  name: string;
  description?: string;
  type: string;
  enabled: boolean;
  agentId: string;
  prompt: string;
  scheduleConfig?: Record<string, unknown>;
  enabledTools?: string[];
  modelId?: string;
  workingDirectory?: string;
  createdAt: string;
  updatedAt: string;
}

interface TriggerResponse {
  trigger: TriggerPayload;
}

interface TriggerListResponse {
  triggers: TriggerPayload[];
  nextToken?: string;
}

type ManageTriggerInput = {
  triggerId?: string;
  name?: string;
  description?: string;
  agentId?: string;
  prompt?: string;
  scheduleConfig?: { expression: string; timezone?: string } & Record<string, unknown>;
  enabledTools?: string[];
  modelId?: string;
  workingDirectory?: string;
};

/** Build a structured error result string from a failed fetch Response. */
async function errorResult(action: string, response: Response): Promise<string> {
  const errorText = await response.text();
  logger.error(
    { action, status: response.status, statusText: response.statusText, error: errorText },
    'manage_trigger backend call failed:'
  );
  return JSON.stringify({
    success: false,
    error: `HTTP ${response.status}: ${response.statusText}`,
    message: errorText,
  });
}

/**
 * Handle create action.
 *
 * Creates a SCHEDULE trigger then disables it so the returned trigger is always
 * inactive (enabled=false) until a human enables it. Schedule triggers actually
 * fire (and incur cost) once enabled, so the disabled-by-default policy is the
 * safety gate keeping agent-created schedules inert until a human reviews them.
 */
async function handleCreate(input: ManageTriggerInput, authHeader: string): Promise<string> {
  const { name, agentId, prompt, scheduleConfig } = input;

  if (!name || !agentId || !prompt || !scheduleConfig?.expression) {
    return JSON.stringify({
      success: false,
      error: 'Missing required parameters for create action',
      message:
        'name, agentId, prompt, and scheduleConfig.expression are required to create a schedule trigger',
    });
  }

  const requestBody = {
    name,
    description: input.description,
    type: 'schedule',
    agentId,
    prompt,
    scheduleConfig,
    enabledTools: input.enabledTools,
    modelId: input.modelId,
    workingDirectory: input.workingDirectory,
  };

  const createUrl = `${config.BACKEND_API_URL}/triggers`;
  logger.info({ url: createUrl, name }, 'Creating schedule trigger via backend API:');

  const createResponse = await fetch(createUrl, {
    method: 'POST',
    headers: buildRequestHeaders(authHeader),
    body: JSON.stringify(requestBody),
  });

  if (!createResponse.ok) {
    return errorResult('create', createResponse);
  }

  const created = (await createResponse.json()) as TriggerResponse;
  let trigger = created.trigger;

  // Enforce the disabled-by-default policy: the Backend creates triggers as
  // enabled, so flip it off immediately. A failure here is reported but the
  // trigger still exists, so surface a clear warning rather than a hard error.
  const disableUrl = `${config.BACKEND_API_URL}/triggers/${trigger.id}/disable`;
  const disableResponse = await fetch(disableUrl, {
    method: 'POST',
    headers: buildRequestHeaders(authHeader),
  });

  if (disableResponse.ok) {
    trigger = ((await disableResponse.json()) as TriggerResponse).trigger;
  } else {
    logger.error(
      { triggerId: trigger.id, status: disableResponse.status },
      'Created trigger but failed to disable it:'
    );
    return JSON.stringify({
      success: true,
      warning:
        'Trigger was created but could not be set to disabled. Please verify and disable it in the Triggers UI.',
      trigger,
    });
  }

  return JSON.stringify({
    success: true,
    trigger,
    message: `Schedule trigger "${trigger.name}" created (id: ${trigger.id}). It is disabled by default; enable it from the Triggers UI to activate.`,
  });
}

/** Handle update action (partial update; never changes enabled state). */
async function handleUpdate(input: ManageTriggerInput, authHeader: string): Promise<string> {
  const { triggerId } = input;
  if (!triggerId) {
    return JSON.stringify({
      success: false,
      error: 'Missing required parameter for update action',
      message: 'triggerId is required for update action',
    });
  }

  const updatePayload: Record<string, unknown> = {};
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.description !== undefined) updatePayload.description = input.description;
  if (input.agentId !== undefined) updatePayload.agentId = input.agentId;
  if (input.prompt !== undefined) updatePayload.prompt = input.prompt;
  if (input.scheduleConfig !== undefined) updatePayload.scheduleConfig = input.scheduleConfig;
  if (input.enabledTools !== undefined) updatePayload.enabledTools = input.enabledTools;
  if (input.modelId !== undefined) updatePayload.modelId = input.modelId;
  if (input.workingDirectory !== undefined) updatePayload.workingDirectory = input.workingDirectory;

  if (Object.keys(updatePayload).length === 0) {
    return JSON.stringify({
      success: false,
      error: 'No fields to update',
      message:
        'At least one field (name, description, agentId, prompt, scheduleConfig, enabledTools, modelId, workingDirectory) must be provided',
    });
  }

  const url = `${config.BACKEND_API_URL}/triggers/${triggerId}`;
  logger.info({ url, triggerId, updateFields: Object.keys(updatePayload) }, 'Updating trigger:');

  const response = await fetch(url, {
    method: 'PUT',
    headers: buildRequestHeaders(authHeader),
    body: JSON.stringify(updatePayload),
  });

  if (!response.ok) {
    return errorResult('update', response);
  }

  const data = (await response.json()) as TriggerResponse;
  return JSON.stringify({
    success: true,
    trigger: data.trigger,
    message: `Trigger "${data.trigger.name}" updated successfully`,
  });
}

/** Handle get action. */
async function handleGet(input: ManageTriggerInput, authHeader: string): Promise<string> {
  const { triggerId } = input;
  if (!triggerId) {
    return JSON.stringify({
      success: false,
      error: 'Missing required parameter for get action',
      message: 'triggerId is required for get action',
    });
  }

  const url = `${config.BACKEND_API_URL}/triggers/${triggerId}`;
  logger.info({ url, triggerId }, 'Getting trigger:');

  const response = await fetch(url, {
    method: 'GET',
    headers: buildRequestHeaders(authHeader),
  });

  if (!response.ok) {
    return errorResult('get', response);
  }

  const data = (await response.json()) as TriggerResponse;
  return JSON.stringify({ success: true, trigger: data.trigger });
}

/** Handle list action. */
async function handleList(authHeader: string): Promise<string> {
  const url = `${config.BACKEND_API_URL}/triggers`;
  logger.info({ url }, 'Listing triggers:');

  const response = await fetch(url, {
    method: 'GET',
    headers: buildRequestHeaders(authHeader),
  });

  if (!response.ok) {
    return errorResult('list', response);
  }

  const data = (await response.json()) as TriggerListResponse;
  return JSON.stringify({
    success: true,
    triggers: data.triggers,
    nextToken: data.nextToken,
    count: data.triggers.length,
  });
}

/**
 * Dispatch a manage_trigger action. Exported for unit testing.
 */
export async function runManageTrigger(
  input: { action: string } & ManageTriggerInput
): Promise<string> {
  const { action } = input;

  logger.info({ action, triggerId: input.triggerId }, 'manage_trigger tool called:');

  const authHeader = getCurrentContext()?.authorizationHeader;
  if (!authHeader) {
    return JSON.stringify({
      success: false,
      error: 'Authentication required',
      message: 'No authentication token available. Cannot manage triggers.',
    });
  }

  try {
    switch (action) {
      case 'create':
        return await handleCreate(input, authHeader);
      case 'update':
        return await handleUpdate(input, authHeader);
      case 'get':
        return await handleGet(input, authHeader);
      case 'list':
        return await handleList(authHeader);
      default:
        return JSON.stringify({
          success: false,
          error: 'Invalid action',
          message: `Unknown action: ${action}. Valid actions are: create, update, get, list`,
        });
    }
  } catch (error) {
    logger.error(
      { action, error: error instanceof Error ? error.message : 'Unknown error' },
      'Error in manage_trigger tool:'
    );
    return JSON.stringify({
      success: false,
      error: 'Operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Manage Trigger Tool Implementation
 */
export const manageTriggerTool = tool({
  name: manageTriggerDefinition.name,
  description: manageTriggerDefinition.description,
  inputSchema: manageTriggerDefinition.zodSchema,
  callback: async (input) => runManageTrigger(input),
});
