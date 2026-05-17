/**
 * MCP client factory
 * Generate appropriate McpClient for each transport
 */

import { McpClient } from '@strands-agents/sdk';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  MCPServerConfig,
  StdioMCPServer,
  HttpMCPServer,
  SseMCPServer,
  Logger,
} from './types.js';
import { MCPConfigError, defaultLogger } from './types.js';

/**
 * Create client for stdio transport
 */
function createStdioClient(
  name: string,
  config: StdioMCPServer,
  logger: Logger = defaultLogger
): McpClient {
  logger.debug?.(
    {
      command: config.command,
      args: config.args,
    },
    `Creating stdio MCP client: ${name}`
  );

  // Environment variables for Lambda environment
  const lambdaEnv = {
    HOME: '/tmp',
    NPM_CONFIG_CACHE: '/tmp/.npm',
  };

  // Merge environment variables (exclude undefined)
  const mergedEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...lambdaEnv, ...(config.env || {}) }).filter(
      ([, value]) => value !== undefined
    )
  );

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args || [],
    env: mergedEnv as Record<string, string> | undefined,
  });

  return new McpClient({
    transport: transport as Transport,
    applicationName: `AgentCore-${name}`,
  });
}

/**
 * Create client for Streamable HTTP transport
 */
function createHttpClient(
  name: string,
  config: HttpMCPServer,
  logger: Logger = defaultLogger
): McpClient {
  logger.debug?.(
    {
      url: config.url,
    },
    `Creating HTTP MCP client: ${name}`
  );

  try {
    const url = new URL(config.url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: config.headers
        ? {
            headers: config.headers,
          }
        : undefined,
    });

    return new McpClient({
      transport: transport as Transport,
      applicationName: `AgentCore-${name}`,
    });
  } catch (error) {
    throw new MCPConfigError(
      `Failed to create HTTP MCP client (${name}): Invalid URL - ${config.url}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Create client for SSE transport
 */
function createSseClient(
  name: string,
  config: SseMCPServer,
  logger: Logger = defaultLogger
): McpClient {
  logger.debug?.(
    {
      url: config.url,
    },
    `Creating SSE MCP client: ${name}`
  );

  try {
    const url = new URL(config.url);
    const transport = new SSEClientTransport(url);

    return new McpClient({
      transport: transport as Transport,
      applicationName: `AgentCore-${name}`,
    });
  } catch (error) {
    throw new MCPConfigError(
      `Failed to create SSE MCP client (${name}): Invalid URL - ${config.url}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate McpClient from MCP server configuration
 *
 * @param name Server name
 * @param config Server configuration
 * @param logger Logger (defaults to console if omitted)
 * @returns McpClient instance
 */
export function createMCPClient(
  name: string,
  config: MCPServerConfig,
  logger: Logger = defaultLogger
): McpClient {
  try {
    switch (config.transport) {
      case 'stdio': {
        return createStdioClient(name, config, logger);
      }
      case 'http': {
        return createHttpClient(name, config, logger);
      }
      case 'sse': {
        return createSseClient(name, config, logger);
      }
      default: {
        // TypeScript exhaustive check
        const _exhaustive: never = config;
        throw new MCPConfigError(
          `Unsupported transport: ${(_exhaustive as { transport?: string }).transport}`
        );
      }
    }
  } catch (error) {
    if (error instanceof MCPConfigError) {
      throw error;
    }
    throw new MCPConfigError(
      `Failed to create MCP client (${name}): ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Generate McpClient array from multiple MCP server configurations
 *
 * @param servers Array of server names and configurations
 * @param logger Logger (defaults to console if omitted)
 * @returns Array of McpClient instances
 */
export function createMCPClients(
  servers: Array<{ name: string; config: MCPServerConfig }>,
  logger: Logger = defaultLogger
): McpClient[] {
  const clients: McpClient[] = [];

  for (const { name, config } of servers) {
    try {
      const client = createMCPClient(name, config, logger);
      clients.push(client);
      logger.info(`MCP client created: ${name} (${config.transport})`);
    } catch (error) {
      logger.error({ err: error }, `Failed to create MCP client: ${name}`);
      // Skip and continue even if error occurs (create other clients)
    }
  }

  return clients;
}
