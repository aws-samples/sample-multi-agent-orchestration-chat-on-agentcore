/**
 * Action handlers for the call_agent tool.
 *
 * These are the impure I/O paths: they touch the sub-agent task manager
 * singleton, the agent registry (network), and the request context. The pure
 * pre-condition guards live in `./validation.js`.
 */

import { ToolContext } from '@strands-agents/sdk';
import { subAgentTaskManager } from '../../../services/sub-agent-task-manager.js';
import { listAgents } from '../../../services/agent-registry.js';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import {
  DEFAULT_MAX_DEPTH,
  checkRecursionDepth,
  hasStartTaskParams,
  hasTaskId,
  validateStartTaskInput,
  validateStatusInput,
} from './validation.js';

/**
 * Sleep utility for polling
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle list_agents action
 */
export async function handleListAgents(): Promise<Record<string, unknown>> {
  try {
    // Pass auth context explicitly for Machine User support.
    // Forward the Cognito ID Token as well — the Backend `authMiddleware`
    // requires the X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header
    // to resolve the Identity Pool identityId on every request.
    const currentContext = getCurrentContext();
    const authHeader = currentContext?.authorizationHeader;
    const agents = await listAgents({
      authHeader,
      userId: currentContext?.userId,
      idToken: currentContext?.idToken,
    });

    return {
      agents: agents.map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        description: agent.description,
      })),
      count: agents.length,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to list agents:');
    return {
      error: 'Failed to list agents',
      message: error instanceof Error ? error.message : 'Unknown error',
      agents: [],
      count: 0,
    };
  }
}

/**
 * Handle start_task action
 */
export async function handleStartTask(
  input: {
    agentId?: string;
    query?: string;
    modelId?: string;
    storagePath?: string;
    sessionId?: string;
  },
  context?: ToolContext
): Promise<Record<string, unknown>> {
  // Validate required parameters. The type guard narrows `input` so the
  // createTask call below needs no non-null assertions.
  if (!hasStartTaskParams(input)) {
    return validateStartTaskInput(input) as Record<string, unknown>;
  }

  // Check recursion depth.
  // `agent.state` was renamed to `agent.appState` in
  // `@strands-agents/sdk@>=0.7.0` (PR #685).
  const currentDepth = (context?.agent?.appState?.get('subAgentDepth') as number) || 0;
  const maxDepth = DEFAULT_MAX_DEPTH; // Default max depth

  const depthError = checkRecursionDepth(currentDepth, maxDepth);
  if (depthError) {
    return depthError;
  }

  try {
    // Get session ID from agent state if available
    const parentSessionId = context?.agent?.appState?.get('sessionId') as string | undefined;

    // Get storagePath from input or inherit from parent
    const storagePath = input.storagePath || context?.agent?.appState?.get('storagePath');

    // Get userId from request context
    const currentContext = getCurrentContext();
    const userId = currentContext?.userId;

    // Create task
    const taskId = await subAgentTaskManager.createTask(input.agentId, input.query, {
      modelId: input.modelId,
      parentSessionId,
      sessionId: input.sessionId,
      userId,
      currentDepth,
      maxDepth,
      storagePath: storagePath as string | undefined,
    });

    // Get the created task to retrieve the sessionId
    const task = await subAgentTaskManager.getTask(taskId);

    return {
      taskId,
      sessionId: task?.sessionId,
      status: 'started',
      agentId: input.agentId,
      message: `Sub-agent task started. Use call_agent with action='status' and taskId="${taskId}" to check results.`,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to start sub-agent task:');
    return {
      error: 'Failed to start task',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handle status action with optional polling
 */
export async function handleStatus(
  input: {
    taskId?: string;
    waitForCompletion?: boolean;
    pollingInterval?: number;
    maxWaitTime?: number;
  },
  _context?: ToolContext
): Promise<Record<string, unknown>> {
  // Validate required parameters. The type guard narrows `input.taskId` to a
  // string for the getTask call below, so no non-null assertion is needed.
  if (!hasTaskId(input)) {
    return validateStatusInput(input) as Record<string, unknown>;
  }

  const waitForCompletion = input.waitForCompletion ?? false;
  const pollingInterval = (input.pollingInterval ?? 30) * 1000; // Convert to ms
  const maxWaitTime = (input.maxWaitTime ?? 1200) * 1000; // Convert to ms

  const startTime = Date.now();
  let pollCount = 0;

  try {
    while (true) {
      pollCount++;

      // Get current task status
      const task = await subAgentTaskManager.getTask(input.taskId);

      if (!task) {
        return {
          error: 'Task not found',
          message: `No task found with ID: ${input.taskId}`,
          taskId: input.taskId,
        };
      }

      const elapsedTime = Math.floor((Date.now() - task.createdAt) / 1000);

      // If task is completed or failed, return immediately
      if (task.status === 'completed') {
        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          status: 'completed',
          agentId: task.agentId,
          result: task.result,
          elapsedTime,
          pollCount: waitForCompletion ? pollCount : undefined,
        };
      }

      if (task.status === 'failed') {
        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          status: 'failed',
          agentId: task.agentId,
          error: task.error,
          elapsedTime,
          pollCount: waitForCompletion ? pollCount : undefined,
        };
      }

      // If not waiting for completion, return current status
      if (!waitForCompletion) {
        return {
          taskId: task.taskId,
          sessionId: task.sessionId,
          status: task.status,
          agentId: task.agentId,
          progress: task.progress,
          elapsedTime,
          message: task.progress || `Task is ${task.status}`,
        };
      }

      // Check if max wait time exceeded
      const totalElapsed = Date.now() - startTime;
      if (totalElapsed >= maxWaitTime) {
        return {
          taskId: task.taskId,
          status: task.status,
          agentId: task.agentId,
          message: `Task still ${task.status} after max wait time (${input.maxWaitTime}s). Check again later.`,
          elapsedTime,
          pollCount,
          timedOut: true,
        };
      }

      // Wait before next poll
      logger.info(
        {
          taskId: input.taskId,
          status: task.status,
          pollCount,
          elapsedTime,
        },
        'Polling sub-agent task:'
      );

      await sleep(pollingInterval);
    }
  } catch (error) {
    logger.error({ error }, 'Failed to check task status:');
    return {
      error: 'Failed to check status',
      message: error instanceof Error ? error.message : 'Unknown error',
      taskId: input.taskId,
    };
  }
}
