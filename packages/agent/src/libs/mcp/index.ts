/**
 * MCP (Model Context Protocol) integration module
 * - HTTP MCP client via AgentCore Gateway
 * - Support for local stdio/http/sse MCP servers
 */

// AgentCore Gateway client (existing)
export { mcpClient, AgentCoreMCPClient, MCPClientError } from './client.js';
export type { MCPToolResult } from './client.js';

// Local MCP server configuration and client (re-exported from local implementation)
export type {
  MCPServerConfig,
  StdioMCPServer,
  HttpMCPServer,
  SseMCPServer,
  MCPConfig,
} from './types.js';
export { MCPConfigError } from './types.js';
export { getEnabledMCPServers } from './config-loader.js';
export { createMCPClient, createMCPClients, clearMCPClientCache } from './client-factory.js';
