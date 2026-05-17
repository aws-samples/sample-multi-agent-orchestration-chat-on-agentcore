/**
 * Manage Agent Tool
 * Create, update, or retrieve AI agent configurations
 */

import { tool } from '@strands-agents/sdk';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import { getCurrentContext } from '../../libs/context/request-context.js';
import { manageAgentDefinition } from '@moca/tool-definitions';

/**
 * Build request headers for backend API calls.
 *
 * Forwards the Cognito ID Token from the current RequestContext as
 * X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token because the Backend
 * `authMiddleware` requires it to resolve the Identity Pool identityId.
 *
 * Automatically includes X-Target-User-Id when running as a machine user
 * (e.g., EventBridge Scheduler triggered execution).
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

/**
 * Backend API response type
 */
interface AgentResponse {
  agent: {
    agentId: string;
    name: string;
    description: string;
    systemPrompt: string;
    enabledTools: string[];
    icon?: string;
    scenarios?: Array<{ id: string; title: string; prompt: string }>;
    createdAt: string;
    updatedAt: string;
  };
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
  };
}

/**
 * Handle create action
 */
async function handleCreate(
  input: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    enabledTools?: string[];
    icon?: string;
    scenarios?: Array<{ title: string; prompt: string }>;
  },
  authHeader: string
): Promise<string> {
  const { name, description, systemPrompt, enabledTools, icon, scenarios } = input;

  // Validate required fields for create
  if (!name || !description || !systemPrompt || !enabledTools) {
    return JSON.stringify({
      success: false,
      error: 'Missing required parameters for create action',
      message: 'name, description, systemPrompt, and enabledTools are required',
    });
  }

  const currentContext = getCurrentContext();
  const url = `${config.BACKEND_API_URL}/agents`;

  logger.info(
    {
      url,
      agentName: name,
      userId: currentContext?.userId,
    },
    'Creating agent via backend API:'
  );

  const requestBody = {
    name,
    description,
    systemPrompt,
    enabledTools,
    icon,
    scenarios: scenarios || [],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: buildRequestHeaders(authHeader),
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      },
      'Failed to create agent:'
    );

    return JSON.stringify({
      success: false,
      error: `HTTP ${response.status}: ${response.statusText}`,
      message: errorText,
    });
  }

  const data = (await response.json()) as AgentResponse;

  logger.info(
    {
      agentId: data.agent.agentId,
      name: data.agent.name,
    },
    'Agent created successfully:'
  );

  return JSON.stringify({
    success: true,
    agentId: data.agent.agentId,
    name: data.agent.name,
    description: data.agent.description,
    enabledTools: data.agent.enabledTools,
    icon: data.agent.icon,
    createdAt: data.agent.createdAt,
    message: `Agent "${data.agent.name}" created successfully with ID: ${data.agent.agentId}`,
  });
}

/**
 * Handle update action
 */
async function handleUpdate(
  input: {
    agentId?: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    enabledTools?: string[];
    icon?: string;
    scenarios?: Array<{ title: string; prompt: string }>;
  },
  authHeader: string
): Promise<string> {
  const { agentId, name, description, systemPrompt, enabledTools, icon, scenarios } = input;

  // Validate agentId for update
  if (!agentId) {
    return JSON.stringify({
      success: false,
      error: 'Missing required parameter for update action',
      message: 'agentId is required for update action',
    });
  }

  // Build update payload with only provided fields
  const updatePayload: Record<string, unknown> = {};
  if (name !== undefined) updatePayload.name = name;
  if (description !== undefined) updatePayload.description = description;
  if (systemPrompt !== undefined) updatePayload.systemPrompt = systemPrompt;
  if (enabledTools !== undefined) updatePayload.enabledTools = enabledTools;
  if (icon !== undefined) updatePayload.icon = icon;
  if (scenarios !== undefined) updatePayload.scenarios = scenarios;

  if (Object.keys(updatePayload).length === 0) {
    return JSON.stringify({
      success: false,
      error: 'No fields to update',
      message:
        'At least one field (name, description, systemPrompt, enabledTools, icon, scenarios) must be provided',
    });
  }

  const currentContext = getCurrentContext();
  const url = `${config.BACKEND_API_URL}/agents/${agentId}`;

  logger.info(
    {
      url,
      agentId,
      updateFields: Object.keys(updatePayload),
      userId: currentContext?.userId,
    },
    'Updating agent via backend API:'
  );

  const response = await fetch(url, {
    method: 'PUT',
    headers: buildRequestHeaders(authHeader),
    body: JSON.stringify(updatePayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      },
      'Failed to update agent:'
    );

    return JSON.stringify({
      success: false,
      error: `HTTP ${response.status}: ${response.statusText}`,
      message: errorText,
    });
  }

  const data = (await response.json()) as AgentResponse;

  logger.info(
    {
      agentId: data.agent.agentId,
      name: data.agent.name,
    },
    'Agent updated successfully:'
  );

  return JSON.stringify({
    success: true,
    agentId: data.agent.agentId,
    name: data.agent.name,
    description: data.agent.description,
    enabledTools: data.agent.enabledTools,
    icon: data.agent.icon,
    updatedAt: data.agent.updatedAt,
    message: `Agent "${data.agent.name}" updated successfully`,
  });
}

/**
 * Handle get action
 */
async function handleGet(input: { agentId?: string }, authHeader: string): Promise<string> {
  const { agentId } = input;

  // Validate agentId for get
  if (!agentId) {
    return JSON.stringify({
      success: false,
      error: 'Missing required parameter for get action',
      message: 'agentId is required for get action',
    });
  }

  const currentContext = getCurrentContext();
  const url = `${config.BACKEND_API_URL}/agents/${agentId}`;

  logger.info(
    {
      url,
      agentId,
      userId: currentContext?.userId,
    },
    'Getting agent via backend API:'
  );

  const response = await fetch(url, {
    method: 'GET',
    headers: buildRequestHeaders(authHeader),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      },
      'Failed to get agent:'
    );

    return JSON.stringify({
      success: false,
      error: `HTTP ${response.status}: ${response.statusText}`,
      message: errorText,
    });
  }

  const data = (await response.json()) as AgentResponse;

  logger.info(
    {
      agentId: data.agent.agentId,
      name: data.agent.name,
    },
    'Agent retrieved successfully:'
  );

  return JSON.stringify({
    success: true,
    agent: {
      agentId: data.agent.agentId,
      name: data.agent.name,
      description: data.agent.description,
      systemPrompt: data.agent.systemPrompt,
      enabledTools: data.agent.enabledTools,
      icon: data.agent.icon,
      scenarios: data.agent.scenarios,
      createdAt: data.agent.createdAt,
      updatedAt: data.agent.updatedAt,
    },
  });
}

/**
 * Manage Agent Tool Implementation
 */
export const manageAgentTool = tool({
  name: manageAgentDefinition.name,
  description: manageAgentDefinition.description,
  inputSchema: manageAgentDefinition.zodSchema,
  callback: async (input) => {
    const { action } = input;

    logger.info(
      {
        action,
        agentId: input.agentId,
      },
      'manage_agent tool called:'
    );

    // Get auth header from request context
    const authHeader = getCurrentContext()?.authorizationHeader;
    if (!authHeader) {
      return JSON.stringify({
        success: false,
        error: 'Authentication required',
        message: 'No authentication token available. Cannot manage agent.',
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
        default:
          return JSON.stringify({
            success: false,
            error: 'Invalid action',
            message: `Unknown action: ${action}. Valid actions are: create, update, get`,
          });
      }
    } catch (error) {
      logger.error(
        {
          action,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Error in manage_agent tool:'
      );

      return JSON.stringify({
        success: false,
        error: 'Operation failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
});
