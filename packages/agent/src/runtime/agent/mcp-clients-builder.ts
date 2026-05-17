/**
 * User-defined MCP client builder
 *
 * Builds MCP clients from user-provided mcp.json configuration.
 */

import type { McpClient } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';
import { getEnabledMCPServers, createMCPClients } from '../../libs/mcp/index.js';
import type { MCPConfig } from '../../libs/mcp/types.js';

/**
 * Build MCP clients from user-defined configuration.
 * Returns an empty array if no config is provided or if an error occurs.
 */
export function buildUserMCPClients(mcpConfig?: Record<string, unknown>): McpClient[] {
  if (!mcpConfig) {
    return [];
  }

  try {
    logger.debug('Processing user-defined MCP configuration');
    const servers = getEnabledMCPServers(mcpConfig as unknown as MCPConfig);
    const clients = createMCPClients(servers);
    logger.debug(`User-defined MCP clients: ${clients.length} items`);
    return clients;
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate user-defined MCP clients:');
    // Skip and continue even if error occurs
    return [];
  }
}
