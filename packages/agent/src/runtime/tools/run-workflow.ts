/**
 * run_workflow tool
 *
 * Thin client of the Backend `/workflows` API. The workflow itself runs in a
 * Lambda durable function, never in this process: a workflow can outlive this
 * microVM (8 h cap) and the caller's 1 h tokens, and parallel steps would
 * otherwise compete for one microVM's CPU and memory.
 */

import { tool } from '@strands-agents/sdk';
import { BEDROCK_MODEL_DEFINITIONS, parseAllowedModelIds } from '@moca/core';
import {
  runWorkflowDefinition,
  validateWorkflowSpec,
  type WorkflowSpec,
} from '@moca/tool-definitions';
import { config } from '../../config/index.js';
import { listCallerAgents } from '../../services/agent-registry.js';
import { logger } from '../../libs/logger/index.js';
import {
  getCallerAuthorizationHeader,
  getCallerIdToken,
  getCurrentContext,
} from '../../libs/context/request-context.js';

type RunWorkflowInput = {
  action: 'start' | 'status' | 'list' | 'cancel' | 'agents';
  workflow?: WorkflowSpec;
  workflowId?: string;
};

function buildHeaders(authHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };
  const context = getCurrentContext();
  const idToken = getCallerIdToken();
  if (idToken) headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'] = idToken;
  // Machine-user turns (triggers) act on behalf of the target user.
  if (context?.isMachineUser && context.userId) headers['X-Target-User-Id'] = context.userId;
  return headers;
}

async function callBackend(
  method: 'GET' | 'POST',
  path: string,
  authHeader: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.BACKEND_API_URL}${path}`, {
    method,
    headers: buildHeaders(authHeader),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    logger.warn({ path, status: response.status }, 'run_workflow backend call failed');
    // The Backend puts the reason phrase in `error` and the actionable detail
    // (e.g. the concurrency limit) in `message`; the agent needs both.
    return {
      success: false,
      status: response.status,
      error: data.message ?? data.error ?? data,
      ...(data.details !== undefined ? { details: data.details } : {}),
    };
  }
  delete data.metadata;
  return { success: true, ...data };
}

/** The deployment's models (IAM is scoped to them); the built-in list in local dev. */
function allowedModels(): Array<{ modelId: string; name: string }> {
  return parseAllowedModelIds(config.BEDROCK_MODEL_IDS).map((id) => ({
    modelId: id,
    name: BEDROCK_MODEL_DEFINITIONS.find((m) => m.id === id)?.name ?? id,
  }));
}

async function listStepCandidates(): Promise<Record<string, unknown>> {
  const result = await listCallerAgents();
  if (!result.ok) return { success: false, error: `Failed to list agents: ${result.error}` };
  return { success: true, agents: result.agents, models: allowedModels() };
}

export async function runWorkflow(input: RunWorkflowInput): Promise<Record<string, unknown>> {
  const authHeader = getCallerAuthorizationHeader();
  if (!authHeader) {
    return { success: false, error: 'No authentication token available' };
  }

  switch (input.action) {
    case 'start': {
      if (!input.workflow) {
        return { success: false, error: 'workflow is required for start' };
      }
      const problems = validateWorkflowSpec(input.workflow, {
        knownModelIds: allowedModels().map((m) => m.modelId),
      });
      if (problems.length > 0) {
        return { success: false, error: 'Invalid workflow', problems };
      }
      const context = getCurrentContext();
      // Steps pull the parent's storagePath from S3 as soon as they start.
      if (context?.workspaceSync) {
        try {
          await context.workspaceSync.syncToS3();
        } catch (error) {
          logger.warn({ err: error }, 'run_workflow: workspace sync before start failed');
        }
      }
      const result = await callBackend('POST', '/workflows', authHeader, {
        workflow: input.workflow,
        parent: {
          sessionId: context?.sessionId,
          sessionType: context?.sessionType,
          agentId: context?.agentId,
          modelId: context?.modelId,
          storagePath: context?.storagePath,
        },
      });
      if (result.success) {
        result.message =
          input.workflow.notifyOnComplete === false
            ? 'Workflow started. Check progress with action=status.'
            : 'Workflow started in the background. You will be resumed in this session with the results when it finishes — tell the user it started and end your turn instead of polling.';
      }
      return result;
    }
    case 'status':
      if (!input.workflowId) return { success: false, error: 'workflowId is required for status' };
      return callBackend('GET', `/workflows/${encodeURIComponent(input.workflowId)}`, authHeader);
    case 'list':
      return callBackend('GET', '/workflows?limit=10', authHeader);
    case 'agents':
      return listStepCandidates();
    case 'cancel':
      if (!input.workflowId) return { success: false, error: 'workflowId is required for cancel' };
      return callBackend(
        'POST',
        `/workflows/${encodeURIComponent(input.workflowId)}/cancel`,
        authHeader
      );
  }
}

export const runWorkflowTool = tool({
  name: runWorkflowDefinition.name,
  description: runWorkflowDefinition.description,
  inputSchema: runWorkflowDefinition.zodSchema,
  callback: async (input) => {
    try {
      return JSON.stringify(await runWorkflow(input as RunWorkflowInput));
    } catch (error) {
      logger.error({ err: error, action: input.action }, 'run_workflow failed');
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
});
