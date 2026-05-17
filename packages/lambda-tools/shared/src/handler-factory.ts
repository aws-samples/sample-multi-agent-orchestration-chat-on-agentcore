/**
 * Lambda handler factory for AgentCore Gateway tool Lambdas
 *
 * Encapsulates the common request lifecycle:
 * 1. Extract request ID and timestamp
 * 2. Parse tool name from Lambda context
 * 3. Resolve tool handler from the registry
 * 4. Execute the tool
 * 5. Build and return the response
 *
 * These Lambda functions are invoked directly via Lambda Invoke API
 * by AgentCore Gateway (not via API Gateway).
 */

import { Context } from 'aws-lambda';
import { logger } from './logger.js';
import { extractToolName, getContextSummary } from './context-parser.js';
import { ToolInput, AgentCoreResponse } from './types.js';
import { ToolHandler } from './tool-types.js';

/**
 * Configuration for creating a Lambda handler
 */
export interface HandlerConfig {
  /**
   * Function that resolves a tool handler by name.
   * Typically delegates to a ToolRegistry instance.
   */
  getToolHandler: (toolName: string | null) => ToolHandler;

  /**
   * Default tool name used in log messages when tool name is null.
   */
  defaultToolName: string;
}

/**
 * Create a Lambda handler function with the standard AgentCore lifecycle
 *
 * @param config - Handler configuration
 * @returns Lambda handler function
 */
export function createHandler(
  config: HandlerConfig
): (event: ToolInput, context: Context) => Promise<AgentCoreResponse> {
  return async (event: ToolInput, context: Context): Promise<AgentCoreResponse> => {
    const reqId = context.awsRequestId;
    const timestamp = new Date().toISOString();

    logger.setRequestId(reqId);

    const contextSummary = getContextSummary(context);
    logger.info('START', {
      timestamp,
      eventKeys: Object.keys(event),
      eventSize: JSON.stringify(event).length,
      ...contextSummary,
    });

    try {
      const toolName = extractToolName(context);
      const toolHandler = config.getToolHandler(toolName);

      logger.info('TOOL_EXEC', {
        tool: toolName || config.defaultToolName,
        inputKeys: Object.keys(event),
        inputSize: JSON.stringify(event).length,
      });

      const result = await toolHandler(event);

      logger.info('SUCCESS', {
        tool: toolName || config.defaultToolName,
        executionTime: context.getRemainingTimeInMillis(),
        resultKeys: Object.keys(result),
      });

      return {
        result,
        metadata: { timestamp, requestId: reqId, toolName: toolName || 'unknown' },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('ERROR', {
        error,
        tool: extractToolName(context) || 'unknown',
        remainingTime: context.getRemainingTimeInMillis(),
      });

      return {
        result: null,
        error: errorMessage,
        metadata: {
          timestamp,
          requestId: reqId,
          toolName: extractToolName(context) || 'unknown',
        },
      };
    }
  };
}
