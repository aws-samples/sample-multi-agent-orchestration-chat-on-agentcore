/**
 * Long-term memory retrieval utility
 *
 * Retrieves long-term memory from AgentCore Memory using semantic search.
 *
 * `client` is REQUIRED and MUST be a user-scoped Bedrock AgentCore client
 * built from Cognito Identity Pool credentials. The Runtime execution role
 * holds NO Memory permissions, so passing an unscoped (execution-role) client
 * would fail at IAM level.
 *
 * `memoryStrategyId` is REQUIRED and is supplied via the
 * `AGENTCORE_SEMANTIC_STRATEGY_ID` environment variable, which CDK resolves at
 * deploy time through an `AwsCustomResource` that calls `GetMemory`. The
 * runtime never calls `GetMemory` itself — this removes latency, keeps the
 * Identity Pool Authenticated Role free of meta-plane permissions, and
 * surfaces configuration errors (missing strategyId) at container startup.

 */

import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { createLogger } from '../../libs/logger/index.js';

const log = createLogger('MemoryRetriever');
/**
 * Type definitions to complement incomplete AWS SDK types
 */
interface MemoryRecordSummary {
  memoryRecordId?: string;
  content?: string | { text?: string };
  createdAt?: Date;
  namespaces?: string[];
  memoryStrategyId?: string;
  metadata?: Record<string, unknown>;
}

interface RetrieveMemoryRecordsParams {
  memoryId: string;
  namespace: string;
  searchCriteria: {
    searchQuery: string;
    memoryStrategyId: string;
    topK: number;
  };
  maxResults: number;
}

/**
 * Retrieve long-term memory from AgentCore Memory.
 *
 * @param memoryId AgentCore Memory ID
 * @param actorId User ID (= identityId, "REGION:UUID")
 * @param memoryStrategyId Semantic strategy id resolved at deploy time
 *                         (`config.AGENTCORE_SEMANTIC_STRATEGY_ID`).
 * @param query Search query (e.g., user's latest message)
 * @param topK Number of items to retrieve (default: 10)
 * @param client User-scoped BedrockAgentCoreClient
 * @returns Array of long-term memory strings
 */
export async function retrieveLongTermMemory(
  memoryId: string,
  actorId: string,
  memoryStrategyId: string,
  query: string,
  topK: number = 10,
  client: BedrockAgentCoreClient
): Promise<string[]> {
  try {
    log.debug(
      {
        actorId,
        memoryStrategyId,
        query: query.substring(0, 100),
        topK,
      },
      `Retrieving long-term memory:`
    );

    const namespace = `/strategies/${memoryStrategyId}/actors/${actorId}`;

    const retrieveParams: RetrieveMemoryRecordsParams = {
      memoryId,
      namespace,
      searchCriteria: {
        searchQuery: query,
        memoryStrategyId,
        topK,
      },
      maxResults: 50,
    };

    const command = new RetrieveMemoryRecordsCommand(retrieveParams);
    const response = await client.send(command);

    // Type assertion for when memoryRecordSummaries is not included in AWS SDK response type
    const extendedResponse = response as typeof response & {
      memoryRecordSummaries?: MemoryRecordSummary[];
    };

    if (
      !extendedResponse.memoryRecordSummaries ||
      extendedResponse.memoryRecordSummaries.length === 0
    ) {
      log.debug(
        {
          namespace,
          memoryStrategyId,
        },
        'No long-term memory found:'
      );
      return [];
    }

    // Extract content
    const memories: string[] = extendedResponse.memoryRecordSummaries
      .map((record: MemoryRecordSummary) => {
        // Extract text property if content is object
        if (typeof record.content === 'object' && record.content?.text) {
          return record.content.text;
        } else if (typeof record.content === 'string') {
          return record.content;
        }
        return '';
      })
      .filter((content) => content.length > 0);

    log.debug(
      {
        memoriesCount: memories.length,
        actorId,
      },
      `Retrieved ${memories.length} long-term memories:`
    );
    return memories;
  } catch (error) {
    // Return empty array for ResourceNotFoundException (new user handling)
    if (error instanceof Error && error.name === 'ResourceNotFoundException') {
      log.debug(`Long-term memory does not exist (new user)`);
      return [];
    }
    log.error({ err: error }, 'Long-term memory retrieval error:');
    // Return empty array on error to continue agent initialization
    return [];
  }
}
