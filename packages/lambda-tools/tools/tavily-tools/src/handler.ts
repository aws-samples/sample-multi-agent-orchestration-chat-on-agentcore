/**
 * AgentCore Gateway Tavily Tools Lambda Handler
 *
 * Uses the shared handler factory with the Tavily tools registry.
 * Invoked directly via Lambda Invoke API by AgentCore Gateway.
 */

import { Context } from 'aws-lambda';
import { createHandler, AgentCoreResponse, ToolInput } from '@moca/lambda-tools-shared';
import { getToolHandler } from './tools/index.js';

/**
 * Main Lambda handler
 */
export const handler: (event: ToolInput, context: Context) => Promise<AgentCoreResponse> =
  createHandler({
    getToolHandler,
    defaultToolName: 'tavily_search',
  });
