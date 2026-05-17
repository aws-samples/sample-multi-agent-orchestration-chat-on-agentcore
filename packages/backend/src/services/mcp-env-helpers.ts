/**
 * Helper functions for extracting, restoring, and stripping env values
 * from MCP configurations.
 *
 * These pure functions are used by AgentsService to separate sensitive
 * env values (stored in SSM) from the rest of the MCP config (stored in DynamoDB).
 */

import type { MCPConfig, MCPServer } from './agents-service.js';
import { SSM_SENTINEL, isSsmSentinel, type McpEnvMap } from './ssm-env-store.js';

/**
 * Extract env values from mcpConfig and replace them with the SSM sentinel.
 *
 * @returns sanitizedConfig with sentinels, and envMap (null if no env values found)
 */
export function extractEnvFromMcpConfig(mcpConfig: MCPConfig): {
  sanitizedConfig: MCPConfig;
  envMap: McpEnvMap | null;
} {
  const envMap: McpEnvMap = {};
  let hasEnv = false;

  const sanitizedServers: Record<string, MCPServer> = {};

  for (const [serverName, server] of Object.entries(mcpConfig.mcpServers)) {
    if (server.env && Object.keys(server.env).length > 0 && !isSsmSentinel(server.env)) {
      // Collect the real env values
      envMap[serverName] = { ...server.env };
      hasEnv = true;

      // Replace env with sentinel in the sanitized copy
      sanitizedServers[serverName] = {
        ...server,
        env: SSM_SENTINEL as unknown as Record<string, string>,
      };
    } else {
      // Keep as-is (no env, or already a sentinel)
      sanitizedServers[serverName] = { ...server };
    }
  }

  return {
    sanitizedConfig: { mcpServers: sanitizedServers },
    envMap: hasEnv ? envMap : null,
  };
}

/**
 * Restore env values from an envMap into an mcpConfig that has SSM sentinels.
 *
 * Servers whose env is not a sentinel are left untouched.
 */
export function restoreEnvToMcpConfig(mcpConfig: MCPConfig, envMap: McpEnvMap): MCPConfig {
  const restoredServers: Record<string, MCPServer> = {};

  for (const [serverName, server] of Object.entries(mcpConfig.mcpServers)) {
    if (isSsmSentinel(server.env) && envMap[serverName]) {
      restoredServers[serverName] = {
        ...server,
        env: { ...envMap[serverName] },
      };
    } else {
      restoredServers[serverName] = { ...server };
    }
  }

  return { mcpServers: restoredServers };
}

/**
 * Strip all env fields from mcpConfig.
 * Used when returning shared agents or preparing clones.
 */
export function stripEnvFromMcpConfig(mcpConfig: MCPConfig): MCPConfig {
  const strippedServers: Record<string, MCPServer> = {};

  for (const [serverName, server] of Object.entries(mcpConfig.mcpServers)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { env, ...rest } = server;
    strippedServers[serverName] = rest;
  }

  return { mcpServers: strippedServers };
}

/**
 * Check whether any server in the mcpConfig has the SSM sentinel.
 */
export function hasSsmSentinel(mcpConfig: MCPConfig): boolean {
  return Object.values(mcpConfig.mcpServers).some((server) => isSsmSentinel(server.env));
}
