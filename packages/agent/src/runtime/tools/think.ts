/**
 * Think tool - Structured reasoning space for the AI agent
 *
 * This tool does NOT execute anything. It provides the agent with
 * a dedicated space to reason through complex problems, analyze
 * tool results, and plan next actions before proceeding.
 */

import { tool } from '@strands-agents/sdk';
import { thinkDefinition } from '@moca/tool-definitions';
import { logger } from '../../libs/logger/index.js';
/**
 * Think tool implementation
 *
 * Returns a short acknowledgment message. The value comes from forcing
 * the model to articulate its reasoning in a structured tool call,
 * which improves subsequent decision quality.
 */
export const thinkTool = tool({
  name: thinkDefinition.name,
  description: thinkDefinition.description,
  inputSchema: thinkDefinition.zodSchema,
  callback: async (input) => {
    const { thought } = input;

    logger.debug(`Think tool invoked (${thought.length} chars)`);

    // Simply acknowledge the thought — no side effects
    return `Thought recorded. Continue with your next action.`;
  },
});
