/**
 * Utility to retrieve tool list from MCP servers
 */
import type {
  MCPConfigFile,
  Logger,
  MCPToolInfo,
  MCPServerError,
  MCPToolsFetchResult,
} from './types.js';
import { defaultLogger } from './types.js';
import { getEnabledMCPServers } from './config-loader.js';
import { createMCPClients } from './client-factory.js';

/**
 * Retrieve tool list from MCP configuration
 *
 * @param mcpConfig MCP server configuration
 * @param logger Logger (defaults to console if omitted)
 * @returns Object containing tools array and errors array
 */
export async function fetchToolsFromMCPConfig(
  mcpConfig: MCPConfigFile,
  logger: Logger = defaultLogger
): Promise<MCPToolsFetchResult> {
  const servers = getEnabledMCPServers(mcpConfig);
  const clients = createMCPClients(servers, logger);
  const allTools: MCPToolInfo[] = [];
  const errors: MCPServerError[] = [];

  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    const serverName = servers[i].name;

    try {
      logger.info(`Tool retrieval started: ${serverName}`);
      const tools = await client.listTools();

      for (const tool of tools) {
        const toolWithSchema = tool as {
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
          input_schema?: Record<string, unknown>;
        };

        allTools.push({
          name: toolWithSchema.name,
          description: toolWithSchema.description,
          inputSchema: toolWithSchema.inputSchema || toolWithSchema.input_schema || {},
          serverName,
        });
      }

      logger.info(`Tool retrieval successful: ${serverName} (${tools.length} items)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, `Tool retrieval failed (${serverName}):`);

      // Capture detailed error information including stack trace
      let errorDetails: string | undefined;
      if (error instanceof Error) {
        // Include stack trace if available
        errorDetails = error.stack;

        // Also check for any additional error data
        if ('data' in error && error.data) {
          errorDetails = `${errorDetails}\n\nAdditional data: ${JSON.stringify(error.data, null, 2)}`;
        }
      }

      // Record error information for frontend display
      errors.push({
        serverName,
        message: errorMessage,
        details: errorDetails,
      });
    }
  }

  return {
    tools: allTools,
    errors,
  };
}
