/**
 * Tools Management API Client
 * Client for calling Backend tools API
 */

import { backendClient } from './client/backend-client';

/**
 * MCP Tool type definition
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * API response type definitions
 */
interface ToolsResponse {
  tools: MCPTool[];
  nextCursor?: string;
  metadata: {
    requestId: string;
    timestamp: string;
    actorId: string;
    count: number;
    query?: string;
  };
}

interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  gateway: {
    connected: boolean;
    endpoint: string;
  };
  metadata: {
    requestId: string;
    timestamp: string;
    actorId: string;
  };
}

/**
 * Fetch list of tools (with pagination support)
 * @param cursor Cursor for pagination (optional)
 * @returns List of tools and nextCursor
 */
export async function fetchTools(cursor?: string): Promise<{
  tools: MCPTool[];
  nextCursor?: string;
}> {
  const url = cursor ? `/tools?cursor=${encodeURIComponent(cursor)}` : '/tools';
  const data = await backendClient.get<ToolsResponse>(url);

  return {
    tools: data.tools,
    nextCursor: data.nextCursor,
  };
}

/**
 * MCP server error information
 */
export interface MCPServerError {
  serverName: string;
  message: string;
  details?: string; // Additional error details (e.g., stack trace, stderr output)
}

/**
 * Result of fetching local MCP tools
 */
export interface MCPToolsFetchResult {
  tools: (MCPTool & { serverName: string })[];
  errors: MCPServerError[];
}

/**
 * Fetch local MCP tools
 * Retrieve tool list from user-defined MCP server configuration
 * @param mcpConfig MCP server configuration in mcp.json format
 * @returns Tool list and error information
 */
export async function fetchLocalMCPTools(
  mcpConfig: Record<string, unknown>
): Promise<MCPToolsFetchResult> {
  const data = await backendClient.post<{
    tools: (MCPTool & { serverName: string })[];
    errors: MCPServerError[];
  }>('/tools/local', {
    mcpConfig,
  });

  return {
    tools: data.tools,
    errors: data.errors || [],
  };
}

/**
 * Search tools
 * @param query Search query
 * @returns List of tools matching search results
 */
export async function searchTools(query: string): Promise<MCPTool[]> {
  if (!query || query.trim().length === 0) {
    throw new Error('Search query is required');
  }

  const data = await backendClient.post<ToolsResponse>('/tools/search', {
    query: query.trim(),
  });

  return data.tools;
}

/**
 * Check Gateway connection status
 * @returns Connection status information
 */
export async function checkGatewayHealth(): Promise<HealthResponse> {
  return backendClient.get<HealthResponse>('/tools/health');
}
