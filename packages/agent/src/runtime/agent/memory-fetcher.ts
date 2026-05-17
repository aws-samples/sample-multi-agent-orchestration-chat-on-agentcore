/**
 * Long-term memory fetcher
 *
 * Retrieves long-term memories from AgentCore Memory for context enrichment.
 *
 * Builds a user-scoped `BedrockAgentCoreClient` from Cognito Identity Pool
 * credentials so that `RetrieveMemoryRecords` is evaluated under the
 * `bedrock-agentcore:namespace` Condition on the Authenticated Role.
 *
 * The semantic strategyId is read from `AGENTCORE_SEMANTIC_STRATEGY_ID`
 * (resolved at CDK deploy time); the runtime no longer calls `GetMemory`.
 */

import type { IdentityId } from '@moca/core';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import { retrieveLongTermMemory } from '../../services/session/memory-retriever.js';
import { createUserScopedBedrockAgentCoreClient } from '../../libs/utils/scoped-credentials.js';
import type { LongTermMemoryParams, LongTermMemoryResult, MemoryConditions } from './types.js';

/**
 * Extract long-term memory parameters from agent options.
 *
 * `actorId` must be a Cognito Identity Pool `IdentityId` (REGION:UUID) —
 * AgentCore Memory IAM conditions key on `${cognito-identity.amazonaws.com:sub}`,
 * so a User Pool `sub` would never satisfy them.
 */
export function extractMemoryParams(options?: {
  memoryEnabled?: boolean;
  actorId?: IdentityId;
  memoryContext?: string;
  memoryTopK?: number;
}): LongTermMemoryParams {
  return {
    enabled: !!options?.memoryEnabled,
    actorId: options?.actorId,
    context: options?.memoryContext,
    topK: options?.memoryTopK,
  };
}

/**
 * Fetch long-term memories based on the provided parameters.
 *
 * Returns empty memories when:
 * - Memory is disabled
 * - AGENTCORE_MEMORY_ID / AGENTCORE_SEMANTIC_STRATEGY_ID is not configured
 * - actorId (= Cognito Identity Pool identityId, already resolved upstream by
 *   `handleInvocation` via `getIdentityId`) or context is missing
 */
export async function fetchLongTermMemories(
  params: LongTermMemoryParams
): Promise<LongTermMemoryResult> {
  const conditions: MemoryConditions = {
    memoryEnabled: params.enabled,
    hasActorId: !!params.actorId,
    hasMemoryContext: !!params.context,
    hasMemoryId: !!config.AGENTCORE_MEMORY_ID,
  };

  logger.debug(conditions, 'Long-term memory retrieval condition check');

  if (!params.enabled) {
    logger.info('Long-term memory is disabled');
    return { memories: [], conditions };
  }

  if (!conditions.hasMemoryId) {
    logger.warn('AGENTCORE_MEMORY_ID is not configured');
    return { memories: [], conditions };
  }
  if (!config.AGENTCORE_SEMANTIC_STRATEGY_ID) {
    logger.warn('AGENTCORE_SEMANTIC_STRATEGY_ID is not configured');
    return { memories: [], conditions };
  }
  if (!conditions.hasActorId) {
    logger.warn('actorId is not provided');
    return { memories: [], conditions };
  }
  if (!conditions.hasMemoryContext) {
    logger.warn('memoryContext is not provided');
    return { memories: [], conditions };
  }

  try {
    // `params.actorId` is the Cognito Identity Pool identityId, already resolved
    // upstream (`handleInvocation` calls `getIdentityId`). The same value is used
    // both as the credential-cache key for `createUserScopedBedrockAgentCoreClient`
    // and as the `actorId` passed to RetrieveMemoryRecords, so the per-user
    // `bedrock-agentcore:actorId` / `:namespace` conditions on the Authenticated
    // Role evaluate against the caller's identity.
    const client = await createUserScopedBedrockAgentCoreClient(params.actorId!);

    const memories = await retrieveLongTermMemory(
      config.AGENTCORE_MEMORY_ID!,
      params.actorId!,
      config.AGENTCORE_SEMANTIC_STRATEGY_ID,
      params.context!,
      params.topK || 10,
      client
    );

    return { memories, conditions };
  } catch (err) {
    logger.error(
      {
        err,
      },
      'Failed to build user-scoped Memory client, returning empty memories:'
    );
    return { memories: [], conditions };
  }
}
