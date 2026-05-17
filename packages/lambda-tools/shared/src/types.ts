/**
 * Shared type definitions for AgentCore Gateway Lambda Tools
 */

/**
 * Tool input data type
 */
export type ToolInput = Record<string, unknown>;

/**
 * Tool result data type
 */
export type ToolResult = Record<string, unknown>;

/**
 * Response metadata attached to every AgentCore response
 */
export interface ResponseMetadata {
  timestamp: string;
  requestId: string;
  toolName: string;
}

/**
 * Standard request format from AgentCore Gateway
 */
export interface AgentCoreRequest {
  tool: string;
  input?: ToolInput;
  sessionId?: string;
  userId?: string;
}

/**
 * Standard response format to AgentCore Gateway
 */
export interface AgentCoreResponse {
  result: ToolResult | null;
  error?: string;
  metadata: ResponseMetadata;
}
