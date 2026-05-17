// Fallback implementation when MCP SDK is not available
// import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/http.js";
// import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
import { getCurrentContext } from '../context/request-context.js';
import type { MCPToolDefinition } from '../../types/index.js';

/**
 * Basic JSONRPC response type
 */
interface JSONRPCResponse<T = unknown> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Tool list response type
 */
interface ListToolsResult {
  tools: Array<MCPToolDefinition>;
  nextCursor?: string;
}

/**
 * Tool call response type
 */
interface CallToolResult {
  toolUseId?: string;
  content?: Array<{
    type: 'text' | 'json';
    text?: string;
    json?: unknown;
  }>;
  isError?: boolean;
}

/**
 * MCP tool call result
 */
export interface MCPToolResult {
  toolUseId: string;
  content: Array<{
    type: 'text' | 'json';
    text?: string;
    json?: unknown;
  }>;
  isError: boolean;
}

/**
 * MCP client error
 */
export class MCPClientError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'MCPClientError';
  }
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  timeout: number;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 100,
  maxDelay: 2000,
  timeout: 30000,
};

/**
 * Type with error cause property
 */
interface ErrorWithCause extends Error {
  cause?: {
    code?: string;
  };
}

/**
 * Determine if error is retryable
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const cause = (error as ErrorWithCause).cause;

  // Node.js network error codes
  const retryableCodes = [
    'econnreset', // Connection reset
    'etimedout', // Timeout
    'econnrefused', // Connection refused
    'epipe', // Broken pipe
    'eai_again', // DNS temporary error
    'enotfound', // DNS resolution error
  ];

  // Check strings in error message
  const retryableMessages = [
    'fetch failed',
    'network error',
    'connection reset',
    'connection refused',
    'timeout',
  ];

  // Check error code
  if (cause?.code) {
    const code = String(cause.code).toLowerCase();
    if (retryableCodes.includes(code)) {
      return true;
    }
  }

  // Check error message
  if (retryableMessages.some((msg) => message.includes(msg))) {
    return true;
  }

  return false;
}

/**
 * Wait with exponential backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry logic
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryConfig: Partial<RetryConfig> = {}
): Promise<Response> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      // Set timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);

      const fetchOptions: RequestInit = {
        ...options,
        signal: controller.signal,
      };

      try {
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        // HTTP 5xx errors are also retryable
        if (response.status >= 500 && response.status < 600 && attempt < cfg.maxRetries) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Throw error if this is the last retry
      if (attempt >= cfg.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryableError(error)) {
        logger.debug(
          { attempt: attempt + 1, errMessage: lastError.message },
          'Non-retryable error'
        );
        throw lastError;
      }

      // Calculate wait time (exponential backoff)
      const delay = Math.min(cfg.baseDelay * Math.pow(2, attempt), cfg.maxDelay);

      logger.debug(
        `Retryable error (attempt ${attempt + 1}/${cfg.maxRetries + 1}): ${lastError.message}, retrying after ${delay}ms`
      );

      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw new MCPClientError(
    `Failed after ${cfg.maxRetries + 1} retries: ${lastError.message}`,
    lastError
  );
}

/**
 * AgentCore Gateway MCP client (HTTP-based)
 */
export class AgentCoreMCPClient {
  private readonly endpointUrl: string;

  constructor() {
    this.endpointUrl = config.AGENTCORE_GATEWAY_ENDPOINT;
    logger.debug(
      {
        endpoint: this.endpointUrl,
      },
      'Initializing AgentCore MCP client'
    );
  }

  /**
   * Get Authorization header (JWT propagation only)
   */
  private getAuthorizationHeader(required = true): string | null {
    // Get Inbound JWT from request context
    const contextAuthHeader = getCurrentContext()?.authorizationHeader;
    if (contextAuthHeader) {
      logger.debug('Using JWT from request context');
      return contextAuthHeader;
    }

    // Handle when JWT is not found
    if (required) {
      throw new MCPClientError(
        'JWT authentication information not found. Authorization header is required in the request.'
      );
    }

    logger.debug('JWT authentication information not found, but not required so continuing');
    return null;
  }

  /**
   * Get list of available tools (with pagination support)
   */
  async listTools(): Promise<Array<MCPToolDefinition>> {
    try {
      logger.debug('Retrieving tool list...');

      // JWT not required during Agent initialization (get tool list without authentication)
      const authHeader = this.getAuthorizationHeader(false);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (authHeader) {
        headers.Authorization = authHeader;
      }

      const allTools = [];
      let cursor: string | undefined = undefined;
      let pageCount = 0;

      // Get all pages while nextCursor exists
      do {
        pageCount++;
        logger.debug(cursor ? { cursor, pageCount } : { pageCount }, 'Retrieving page');

        const params = cursor ? { cursor } : {};

        const response = await fetchWithRetry(this.endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: pageCount,
            method: 'tools/list',
            params,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as JSONRPCResponse<ListToolsResult>;

        if (config.DEBUG_MCP) {
          logger.debug(data, `Page ${pageCount} retrieval result:`);
        }

        if (data.error) {
          throw new Error(`MCP Error: ${data.error.message}`);
        }

        if (!data.result) {
          throw new Error('Tool list result is empty');
        }

        // Add tools from this page
        allTools.push(...data.result.tools);
        logger.debug(`Page ${pageCount}: Retrieved ${data.result.tools.length} tools`);

        // Check if there's a next page
        cursor = data.result.nextCursor;
      } while (cursor);

      logger.info(`Retrieved total of ${allTools.length} tools from ${pageCount} pages`);
      return allTools;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: errorMessage }, 'Failed to retrieve tool list:');

      throw new MCPClientError(
        `Failed to retrieve tool list: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Call tool
   */
  async callTool(toolName: string, arguments_: Record<string, unknown>): Promise<MCPToolResult> {
    try {
      logger.debug({ toolName, arguments: arguments_ }, 'Calling tool');

      // JWT authentication required for tool calls
      const authHeader = this.getAuthorizationHeader(true);
      // RequestContext is guaranteed to exist during MCP tool invocation
      // (the full middleware chain has run before any agent execution), so
      // a populated storagePath is always available.
      const context = getCurrentContext()!;
      const storagePath = context.storagePath;
      // Forward the Cognito ID Token so the Gateway interceptor can resolve identityId.
      // The interceptor requires an ID Token (not an Access Token) for GetId.
      const idToken = context.idToken;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-storage-path': storagePath,
        ...(idToken && {
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': idToken,
        }),
      };

      if (authHeader) {
        headers.Authorization = authHeader;
      }

      const response = await fetchWithRetry(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: arguments_,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as JSONRPCResponse<CallToolResult>;

      if (config.DEBUG_MCP) {
        logger.debug(data, 'Tool call result:');
      }

      if (data.error) {
        return {
          toolUseId: 'error',
          content: [{ type: 'text', text: `MCP Error: ${data.error.message}` }],
          isError: true,
        };
      }

      // Convert response to unified format
      const result: MCPToolResult = {
        toolUseId: data.result?.toolUseId || 'unknown',
        content: data.result?.content || [
          { type: 'text', text: JSON.stringify(data.result || {}) },
        ],
        isError: data.result?.isError || false,
      };

      logger.info(
        {
          toolName,
          success: !result.isError,
        },
        'Tool call completed:'
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: errorMessage }, 'Tool call failed:');

      throw new MCPClientError(
        `Tool call failed: ${errorMessage}`,
        error instanceof Error ? error : undefined
      );
    }
  }
}

/**
 * Singleton MCP client
 */
export const mcpClient = new AgentCoreMCPClient();
