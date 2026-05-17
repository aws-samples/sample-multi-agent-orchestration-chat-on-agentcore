/**
 * Type definitions for MCP server configuration
 * Supports three transport types: stdio / http / sse
 */

/**
 * Common options
 */
interface MCPServerBase {
  /** Whether to enable the server (default: true) */
  enabled?: boolean;
  /** Add a prefix to tool names (to avoid conflicts) */
  prefix?: string;
}

/**
 * stdio transport configuration
 * Launches a local process for communication
 */
export interface StdioMCPServer extends MCPServerBase {
  transport: 'stdio';
  /** Execution command (e.g., "uvx", "npx", "python") */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables (other env vars can be referenced using ${VAR} format) */
  env?: Record<string, string>;
}

/**
 * Streamable HTTP transport configuration
 * Communicates with MCP server via HTTP
 */
export interface HttpMCPServer extends MCPServerBase {
  transport: 'http';
  /** URL of the MCP server */
  url: string;
  /** Request headers (env vars can be referenced using ${VAR} format) */
  headers?: Record<string, string>;
}

/**
 * SSE (Server-Sent Events) transport configuration
 * Communicates with MCP server via SSE
 */
export interface SseMCPServer extends MCPServerBase {
  transport: 'sse';
  /** URL of the MCP server */
  url: string;
  /** Request headers (env vars can be referenced using ${VAR} format) */
  headers?: Record<string, string>;
}

/**
 * Union type for MCP server configuration
 */
export type MCPServerConfig = StdioMCPServer | HttpMCPServer | SseMCPServer;

/**
 * Overall configuration for mcp.json
 */
export interface MCPConfig {
  /** MCP server definitions (key: server name) */
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * MCP client creation error
 */
export class MCPConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'MCPConfigError';
  }
}
