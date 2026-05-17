/**
 * Tavily tools registry
 *
 * Registers available tools and exports the registry for handler use.
 */

import { ToolRegistry } from '@moca/lambda-tools-shared';
import { tavilySearchTool } from './tavily-search.js';
import { tavilyExtractTool } from './tavily-extract.js';
import { tavilyCrawlTool } from './tavily-crawl.js';

/**
 * Tool registry with all Tavily tools registered.
 * Default tool is `tavily_search` (exposed as 'tavily-tools___tavily_search' via AgentCore Gateway).
 */
export const registry = new ToolRegistry(
  [tavilySearchTool, tavilyExtractTool, tavilyCrawlTool],
  tavilySearchTool
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
