/**
 * Tools builder
 *
 * Integrates local tools, AgentCore Gateway MCP tools, and user-defined MCP clients
 * into a unified tool set for the agent.
 */

import type { McpClient, Tool } from '@strands-agents/sdk';
import { supportsToolResultImages } from '@moca/core';
import { RUNTIME_TOOL_NAMES } from '@moca/tool-definitions';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import { localTools, convertMCPToolsToStrands } from '../tools/index.js';
import { mcpClient } from '../../libs/mcp/client.js';
import type { MCPToolDefinition } from '../../types/schemas/types.js';

/**
 * Select enabled tools from the provided list.
 *
 * Behavior:
 * - `enabledTools === undefined` → returns empty array (no tools enabled by default)
 * - `enabledTools === []` → returns empty array (explicitly disabled)
 * - `enabledTools === ['tool1', 'tool2']` → returns only matching tools
 */
export function selectEnabledTools<T extends { name: string }>(
  tools: T[],
  enabledTools?: string[]
): T[] {
  if (enabledTools === undefined) return [];
  if (enabledTools.length === 0) {
    logger.info('Tools disabled: Empty array specified');
    return [];
  }

  const filtered = tools.filter((tool) => enabledTools.includes(tool.name));
  logger.debug(`Filtering tools: ${enabledTools.join(', ')}`);
  return filtered;
}

/** Tools whose results carry an image block. */
const IMAGE_RESULT_TOOLS: ReadonlySet<string> = new Set([RUNTIME_TOOL_NAMES.VIEW_IMAGE]);

/**
 * Drop tools the model cannot take results from. An image in a tool result is
 * rejected by models that do not support it, and the failed request ends the
 * turn — so such a tool is withheld rather than left for the model to trip on.
 */
export function selectToolsForModel<T extends { name: string }>(tools: T[], modelId: string): T[] {
  if (supportsToolResultImages(modelId)) return tools;

  const usable = tools.filter((tool) => !IMAGE_RESULT_TOOLS.has(tool.name));
  if (usable.length < tools.length) {
    logger.info(`Image-returning tools withheld: ${modelId} does not accept images in tool results`);
  }
  return usable;
}

/**
 * Result of building the complete tool set
 */
export interface ToolSetResult {
  /** Resolved tools (local + Gateway MCP converted to Strands format) */
  tools: Tool[];
  /** User-defined MCP clients (lazy-resolved by SDK Agent at initialize time) */
  mcpClients: McpClient[];
  /** Raw Gateway MCP tool definitions (used for prompt generation) */
  gatewayMCPTools: MCPToolDefinition[];
  /** Tool count breakdown for logging */
  counts: {
    local: number;
    gateway: number;
    userMCP: number;
    total: number;
  };
}

/**
 * Build the complete tool set by combining local, Gateway MCP, and user MCP tools.
 *
 * @param enabledTools - Tool name filter (undefined=none, []=none, ['name',...]=filtered)
 * @param userMCPClients - MCP clients from user configuration (always fully included)
 * @param modelId - Model the agent runs on; tools it cannot use are withheld
 */
export async function buildToolSet(
  enabledTools?: string[],
  userMCPClients: McpClient[] = [],
  modelId: string = config.BEDROCK_MODEL_ID
): Promise<ToolSetResult> {
  // Fetch Gateway MCP tools
  const gatewayMCPTools = (await mcpClient.listTools()) as MCPToolDefinition[];

  // Convert Gateway MCP tools to Strands format
  const gatewayStrandsTools = convertMCPToolsToStrands(gatewayMCPTools);

  // Filter local + gateway tools by enabledTools list
  const filteredTools = selectToolsForModel(
    selectEnabledTools([...localTools, ...gatewayStrandsTools], enabledTools),
    modelId
  );

  const counts = {
    local: localTools.length,
    gateway: gatewayStrandsTools.length,
    userMCP: userMCPClients.length,
    total: filteredTools.length + userMCPClients.length,
  };

  logger.info(
    `Prepared total of ${counts.total} tools (Local: ${counts.local}, Gateway: ${counts.gateway}, User MCP: ${counts.userMCP})`
  );

  return { tools: filteredTools, mcpClients: userMCPClients, gatewayMCPTools, counts };
}
