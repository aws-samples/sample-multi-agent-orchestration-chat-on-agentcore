/**
 * MCP client factory
 * Generate appropriate McpClient for each transport
 * Includes in-memory caching for client reuse
 */

import { McpClient } from '@strands-agents/sdk';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../logger/index.js';
import type { MCPServerConfig, StdioMCPServer, HttpMCPServer, SseMCPServer } from './types.js';
import { MCPConfigError } from './types.js';

/**
 * In-memory cache for MCP clients
 * Key: Normalized JSON string of server configurations
 * Value: Array of McpClient instances
 */
const clientCache = new Map<string, McpClient[]>();

/**
 * Generate cache key from server configurations
 * Normalizes and sorts configurations to ensure consistent keys
 *
 * @param servers Array of server names and configurations
 * @returns Cache key string
 */
function generateCacheKey(servers: Array<{ name: string; config: MCPServerConfig }>): string {
  // Normalize and sort by server name for consistent cache keys
  const normalized = servers
    .map((s) => ({
      name: s.name,
      config: s.config,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(normalized);
}

/**
 * Clear the MCP client cache
 * Useful for testing and cleanup scenarios
 */
export function clearMCPClientCache(): void {
  const cacheSize = clientCache.size;
  clientCache.clear();
  logger.info(`MCP client cache cleared (${cacheSize} entries removed)`);
}

/**
 * Create client for stdio transport
 */
function createStdioClient(name: string, config: StdioMCPServer): McpClient {
  logger.debug(
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
function createHttpClient(name: string, config: HttpMCPServer): McpClient {
  logger.debug(
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
function createSseClient(name: string, config: SseMCPServer): McpClient {
  logger.debug(
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
 * @returns McpClient instance
 */
export function createMCPClient(name: string, config: MCPServerConfig): McpClient {
  try {
    switch (config.transport) {
      case 'stdio': {
        return createStdioClient(name, config);
      }
      case 'http': {
        return createHttpClient(name, config);
      }
      case 'sse': {
        return createSseClient(name, config);
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
 * Uses in-memory caching to reuse clients for identical configurations
 *
 * @param servers Array of server names and configurations
 * @returns Array of McpClient instances
 */
export function createMCPClients(
  servers: Array<{ name: string; config: MCPServerConfig }>
): McpClient[] {
  // Generate cache key from configuration
  const cacheKey = generateCacheKey(servers);

  // Check cache first
  const cached = clientCache.get(cacheKey);
  if (cached) {
    logger.debug(
      `Reusing cached MCP clients (${cached.length} items, cache key: ${cacheKey.substring(0, 50)}...)`
    );
    return cached;
  }

  // Create new clients if cache miss
  logger.debug('Creating new MCP clients (cache miss)');
  const clients: McpClient[] = [];

  for (const { name, config } of servers) {
    try {
      const client = createMCPClient(name, config);
      clients.push(client);
      logger.debug(`MCP client created: ${name} (${config.transport})`);
    } catch (error) {
      logger.error({ err: error }, `Failed to create MCP client: ${name}`);
      // Skip and continue even if error occurs (create other clients)
    }
  }

  // Store in cache
  clientCache.set(cacheKey, clients);
  logger.debug(
    `Cached MCP clients (${clients.length} items, cache key: ${cacheKey.substring(0, 50)}...)`
  );

  return clients;
}
