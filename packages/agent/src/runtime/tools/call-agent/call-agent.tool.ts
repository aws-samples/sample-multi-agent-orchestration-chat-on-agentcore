/**
 * Call Agent Tool
 * Invoke sub-agents asynchronously with action-based workflow
 */

import { tool, ToolContext } from '@strands-agents/sdk';
import { callAgentDefinition } from '@moca/tool-definitions';
import { handleListAgents, handleStartTask, handleStatus } from './actions.js';

/**
 * Call Agent Tool
 * Unified tool for starting and checking sub-agent tasks
 */
export const callAgentTool = tool({
  name: callAgentDefinition.name,
  description: callAgentDefinition.description,
  inputSchema: callAgentDefinition.zodSchema,
  callback: async (input, context?: ToolContext) => {
    let result: Record<string, unknown>;

    if (input.action === 'list_agents') {
      result = await handleListAgents();
    } else if (input.action === 'start_task') {
      result = await handleStartTask(input, context);
    } else {
      result = await handleStatus(input, context);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result as any;
  },
});
