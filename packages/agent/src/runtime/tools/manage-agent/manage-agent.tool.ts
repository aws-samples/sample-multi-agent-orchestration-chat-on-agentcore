/**
 * Manage Agent Tool
 * Create, update, or retrieve AI agent configurations
 */

import { tool } from '@strands-agents/sdk';
import { manageAgentDefinition } from '@moca/tool-definitions';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext } from '../../../libs/context/request-context.js';
import { handleCreate, handleGet, handleUpdate } from './actions.js';

/**
 * Manage Agent Tool Implementation
 *
 * Every path returns a JSON envelope string ({ success: true, ... } on success,
 * { success: false, error, message } on guidance / failure). The generic
 * `defineTool` wrapper is intentionally NOT used here because its error
 * formatter would replace this structured envelope.
 */
export const manageAgentTool = tool({
  name: manageAgentDefinition.name,
  description: manageAgentDefinition.description,
  inputSchema: manageAgentDefinition.zodSchema,
  callback: async (input) => {
    const { action } = input;

    logger.info(
      {
        action,
        agentId: input.agentId,
      },
      'manage_agent tool called:'
    );

    // Get auth header from request context
    const authHeader = getCurrentContext()?.authorizationHeader;
    if (!authHeader) {
      return JSON.stringify({
        success: false,
        error: 'Authentication required',
        message: 'No authentication token available. Cannot manage agent.',
      });
    }

    try {
      switch (action) {
        case 'create':
          return await handleCreate(input, authHeader);
        case 'update':
          return await handleUpdate(input, authHeader);
        case 'get':
          return await handleGet(input, authHeader);
        default:
          return JSON.stringify({
            success: false,
            error: 'Invalid action',
            message: `Unknown action: ${action}. Valid actions are: create, update, get`,
          });
      }
    } catch (error) {
      logger.error(
        {
          action,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Error in manage_agent tool:'
      );

      return JSON.stringify({
        success: false,
        error: 'Operation failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
});
