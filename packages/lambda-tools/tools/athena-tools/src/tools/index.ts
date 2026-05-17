/**
 * Athena tools registry
 *
 * Registers available Athena tools and exports the registry for handler use.
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { athenaQueryTool } from './athena-query.js';
import { athenaListTablesTool } from './athena-list-tables.js';
import { athenaDescribeTableTool } from './athena-describe-table.js';

/**
 * Tool registry with all Athena tools registered.
 * Default tool is `athena-list-tables` (used when tool name is not provided or not found).
 */
export const registry = new ToolRegistry(
  [athenaQueryTool, athenaListTablesTool, athenaDescribeTableTool],
  athenaListTablesTool
);

/**
 * Get a tool handler by name (convenience wrapper)
 *
 * @param toolName - Tool name (null falls back to default)
 * @returns Tool handler function
 */
export function getToolHandler(toolName: string | null) {
  return registry.getHandler(toolName);
}

/**
 * Get all available tool names
 *
 * @returns Array of tool names
 */
export function getToolNames(): string[] {
  return registry.getNames();
}
