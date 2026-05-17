import { tool } from '@strands-agents/sdk';
import { MCPToolDefinition, ToolInput } from '../../types/schemas/types.js';
import { convertToZodSchema } from '../../types/schemas/zod-converter.js';
import { mcpClient, MCPToolResult } from '../../libs/mcp/client.js';
import { logger } from '../../libs/logger/index.js';
/**
 * Convert MCP tools to Strands tools
 */
export function createStrandsToolFromMCP(mcpTool: MCPToolDefinition) {
  const { schema, keyMapping } = convertToZodSchema(mcpTool.inputSchema);

  return tool({
    name: mcpTool.name,
    description: mcpTool.description || `AgentCore Gateway tool: ${mcpTool.name}`,
    inputSchema: schema,
    callback: async (input: ToolInput): Promise<string> => {
      try {
        // Convert sanitized keys to original keys
        const originalInput: Record<string, unknown> = {};
        for (const [sanitizedKey, value] of Object.entries(input)) {
          const originalKey = keyMapping[sanitizedKey] || sanitizedKey;
          originalInput[originalKey] = value;
        }

        logger.debug({ originalInput }, `Tool call: ${mcpTool.name}`);
        const result: MCPToolResult = await mcpClient.callTool(mcpTool.name, originalInput);

        if (result.isError) {
          logger.error(result, `Tool execution error: ${mcpTool.name}`);
          return `Tool execution error: ${result.content[0]?.text || 'Unknown error'}`;
        }

        // Return result as string
        const contentText = result.content
          .map((item) => {
            if (item.text) return item.text;
            if (item.json) return JSON.stringify(item.json, null, 2);
            return '';
          })
          .filter(Boolean)
          .join('\n');

        return contentText || 'Tool execution completed.';
      } catch (error) {
        logger.error({ err: error }, `Error during tool call: ${mcpTool.name}`);
        return `An error occurred during tool call: ${error}`;
      }
    },
  });
}

/**
 * Batch convert MCP tool list to Strands tools
 * @param mcpTools Already retrieved list of MCP tools
 */
export function convertMCPToolsToStrands(
  mcpTools: MCPToolDefinition[]
): Array<ReturnType<typeof tool>> {
  logger.debug(`Converting ${mcpTools.length} MCP tools`);

  return mcpTools.map((mcpTool) => {
    logger.debug(`Converting tool: ${mcpTool.name}`);
    return createStrandsToolFromMCP(mcpTool);
  });
}
