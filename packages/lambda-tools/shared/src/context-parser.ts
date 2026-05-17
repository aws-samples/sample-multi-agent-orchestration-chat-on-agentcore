/**
 * AgentCore Gateway context parsing utility
 *
 * Extracts tool name and metadata from Lambda execution context.
 */

import { Context } from 'aws-lambda';
import { logger } from './logger.js';

/**
 * Lambda ClientContext type definition
 */
interface LambdaClientContext {
  custom?: {
    bedrockAgentCoreToolName?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Safely extract tool name from the Lambda execution context
 *
 * The tool name is injected by AgentCore Gateway via `clientContext.custom.bedrockAgentCoreToolName`.
 * The value may include a Gateway Target prefix (e.g., "athena-tools___athena-query")
 * which is automatically stripped.
 *
 * @param context - Lambda execution context
 * @returns Extracted tool name, or null if not available
 */
export function extractToolName(context: Context): string | null {
  try {
    if (!context.clientContext) {
      logger.info('CONTEXT', {
        status: 'no_client_context',
        invocationType: 'direct_or_unknown',
      });
      return null;
    }

    const customContext = (context.clientContext as unknown as LambdaClientContext).custom;

    if (!customContext) {
      logger.info('CONTEXT', {
        status: 'no_custom_context',
        clientContext: context.clientContext,
      });
      return null;
    }

    const originalToolName = customContext.bedrockAgentCoreToolName as string;

    if (!originalToolName) {
      logger.info('CONTEXT', {
        status: 'no_tool_name',
        customKeys: Object.keys(customContext),
      });
      return null;
    }

    // Strip Gateway Target prefix (e.g., "athena-tools___athena-query" -> "athena-query")
    const processedToolName = extractActualToolName(originalToolName);

    logger.info('CONTEXT', {
      originalTool: originalToolName,
      processedTool: processedToolName,
      clientContext: context.clientContext,
    });

    return processedToolName;
  } catch (error) {
    logger.warn('CONTEXT_ERROR', {
      error,
      contextKeys: context.clientContext ? Object.keys(context.clientContext) : [],
    });
    return null;
  }
}

/**
 * Strip the Gateway Target prefix from a tool name
 *
 * @param toolName - Full tool name (e.g., "echo-tool___echo")
 * @returns Actual tool name (e.g., "echo")
 */
export function extractActualToolName(toolName: string): string {
  const delimiter = '___';

  if (toolName && toolName.includes(delimiter)) {
    return toolName.substring(toolName.indexOf(delimiter) + delimiter.length);
  }

  return toolName;
}

/**
 * Build a context summary for structured logging
 *
 * @param context - Lambda execution context
 * @returns Structured context summary
 */
export function getContextSummary(context: Context) {
  return {
    functionName: context.functionName,
    functionVersion: context.functionVersion,
    memoryLimit: context.memoryLimitInMB,
    remainingTime: context.getRemainingTimeInMillis(),
    hasClientContext: !!context.clientContext,
    clientContextKeys: context.clientContext ? Object.keys(context.clientContext) : [],
  };
}
