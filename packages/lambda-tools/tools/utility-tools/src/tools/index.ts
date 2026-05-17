/**
 * Utility tools registry
 *
 * Registers available tools and exports the registry for handler use.
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { echoTool } from './echo.js';
import { pingTool } from './ping.js';

/**
 * Tool registry with all utility tools registered.
 * Default tool is `ping` (used when tool name is not provided or not found).
 * Note: Knowledge Base (kb-retrieve) tool has been moved to the separate kb-tools Lambda.
 */
export const registry = new ToolRegistry([echoTool, pingTool], pingTool);

/**
 * Get a tool handler by name (convenience wrapper)
 *
 * @param toolName - Tool name (null falls back to default)
 * @returns Tool handler function
 */
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}
