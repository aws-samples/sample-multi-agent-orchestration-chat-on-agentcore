/**
 * Action handlers for the manage_agent tool.
 *
 * These are the impure I/O paths: each one calls the backend `/agents` API
 * over the network and returns a fully-formed JSON envelope string. The outer
 * dispatch/auth wiring lives in `./manage-agent.tool.js`.
 */

import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import { AgentResponse, buildRequestHeaders } from './headers.js';

/**
 * Handle create action
 */
export async function handleCreate(
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
export async function handleUpdate(
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
export async function handleGet(input: { agentId?: string }, authHeader: string): Promise<string> {
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
