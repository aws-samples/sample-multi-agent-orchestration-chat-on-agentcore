/**
 * Knowledge Base tools registry
 *
 * Registers available tools and exports the registry for handler use.
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { kbRetrieveTool } from './kb-retrieve.js';

/**
 * Tool registry with all Knowledge Base tools registered.
 * Default tool is `retrieve` (exposed as 'knowledge-base-tools__retrieve' via AgentCore Gateway).
 */
export const registry = new ToolRegistry([kbRetrieveTool], kbRetrieveTool);

/**
 * Get a tool handler by name (convenience wrapper)
 *
 * @param toolName - Tool name (null falls back to default)
 * @returns Tool handler function
 */
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}
