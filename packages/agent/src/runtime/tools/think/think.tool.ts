/**
 * Think tool - Structured reasoning space for the AI agent
 *
 * This tool does NOT execute anything. It provides the agent with a dedicated
 * space to reason through complex problems, analyze tool results, and plan next
 * actions before proceeding.
 *
 * Returns a short acknowledgment message. The value comes from forcing the
 * model to articulate its reasoning in a structured tool call, which improves
 * subsequent decision quality. There is no request context and no error path,
 * so the handler simply logs and returns the acknowledgment.
 */

import { thinkDefinition } from '@moca/tool-definitions';
import { logger } from '../../../libs/logger/index.js';
import { defineTool } from '../_shared/index.js';

export const thinkTool = defineTool(thinkDefinition, async (input) => {
  const { thought } = input;

  logger.debug(`Think tool invoked (${thought.length} chars)`);

  // Simply acknowledge the thought — no side effects
  return `Thought recorded. Continue with your next action.`;
});
