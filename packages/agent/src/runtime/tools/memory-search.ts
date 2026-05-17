/**
 * Memory Search Tool - Ad-hoc long-term memory retrieval via ToolUse
 *
 * Allows the agent to perform semantic searches against AgentCore Memory
 * at any point during a conversation, complementing the session-startup
 * memory retrieval that is embedded in the system prompt.
 */

import { tool } from '@strands-agents/sdk';
import { memorySearchDefinition } from '@moca/tool-definitions';
import { retrieveLongTermMemory } from '../../services/session/memory-retriever.js';
import { getCurrentContext } from '../../libs/context/request-context.js';
import { createUserScopedBedrockAgentCoreClient } from '../../libs/utils/scoped-credentials.js';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
/**
 * Memory Search Tool
 *
 * Resolves actorId and memoryId from server-side context (not from user input)
 * to ensure users can only access their own memories.
 */
export const memorySearchTool = tool({
  name: memorySearchDefinition.name,
  description: memorySearchDefinition.description,
  inputSchema: memorySearchDefinition.zodSchema,
  callback: async (input) => {
    const { query, topK } = input;

    logger.info(
      {
        query: query.substring(0, 100),
        topK,
      },
      `memory_search tool invoked:`
    );

    // Validate memoryId from config
    const memoryId = config.AGENTCORE_MEMORY_ID;
    if (!memoryId) {
      logger.warn('[memory_search] AGENTCORE_MEMORY_ID is not configured');
      return (
        'Long-term memory is not configured for this environment. ' +
        'AGENTCORE_MEMORY_ID is not set. Memory search is unavailable.'
      );
    }

    // Validate strategyId from config (resolved at CDK deploy time)
    const strategyId = config.AGENTCORE_SEMANTIC_STRATEGY_ID;
    if (!strategyId) {
      logger.warn('[memory_search] AGENTCORE_SEMANTIC_STRATEGY_ID is not configured');
      return (
        'Long-term memory strategy is not configured for this environment. ' +
        'AGENTCORE_SEMANTIC_STRATEGY_ID is not set. Memory search is unavailable.'
      );
    }

    // Resolve actorId from request context.
    //
    // Memory IAM conditions (`bedrock-agentcore:actorId` /
    // `bedrock-agentcore:namespace`) are evaluated against
    // `${cognito-identity.amazonaws.com:sub}` (= identityId), so the actorId
    // MUST be the Identity Pool identityId, NOT the User Pool sub. The
    // identityId is populated on `context` by `assumeUserScopedRole` during
    // `handleInvocation`, well before any tool is dispatched.
    const context = getCurrentContext();
    const actorId = context?.identityId;
    if (!actorId) {
      logger.warn('[memory_search] Could not resolve identityId from request context');
      return (
        'Could not determine the current user identity. ' +
        'Identity Pool identityId has not been resolved for this request.'
      );
    }

    try {
      // Build user-scoped Memory client so that RetrieveMemoryRecords is
      // evaluated under the per-user bedrock-agentcore:namespace condition
      // on the Authenticated Role.
      const client = await createUserScopedBedrockAgentCoreClient(actorId);

      const memories = await retrieveLongTermMemory(
        memoryId,
        actorId,
        strategyId,
        query,
        topK,
        client
      );

      if (memories.length === 0) {
        logger.info(`[memory_search] No memories found for query: "${query.substring(0, 100)}"`);
        return `No memories found for query: "${query}". The user may not have relevant past interactions on this topic.`;
      }

      // Format results as numbered list
      const formattedMemories = memories
        .map((memory, index) => `${index + 1}. ${memory}`)
        .join('\n');

      logger.info(`[memory_search] Retrieved ${memories.length} memories`);

      return (
        `Found ${memories.length} relevant memory record(s) for query "${query}":\n\n` +
        formattedMemories
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error: errorMessage, query }, `[memory_search] Error searching memories:`);

      return (
        `An error occurred while searching long-term memory: ${errorMessage}. ` +
        'You may continue the conversation without this context.'
      );
    }
  },
});
