/**
 * Knowledge Base Retrieve tool implementation
 *
 * Retrieves relevant chunks from Amazon Bedrock Knowledge Base
 * using semantic search.
 */

import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { ToolInput, ToolResult, Tool, ToolValidationError, logger } from '@moca/lambda-tools-shared';

/**
 * Knowledge Base Retrieve tool input type
 */
interface KbRetrieveInput extends ToolInput {
  knowledgeBaseId?: string;
  query?: string;
  numberOfResults?: number;
}

/**
 * Knowledge Base Retrieve tool output type
 */
interface KbRetrieveResult extends ToolResult {
  retrievedChunks: {
    content: string;
    score?: number;
    location?: {
      type: string;
      uri?: string;
    };
    metadata?: Record<string, unknown>;
  }[];
  totalCount: number;
  knowledgeBaseId: string;
  query: string;
}

/**
 * Bedrock Agent Runtime client instance
 */
const bedrockClient = new BedrockAgentRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

/**
 * Main handler for the kb-retrieve tool
 *
 * @param input - Tool input data
 * @returns Retrieved chunks from Knowledge Base
 */
async function handleKbRetrieve(input: ToolInput): Promise<KbRetrieveResult> {
  const kbInput = input as KbRetrieveInput;

  // Validate required parameters
  if (!kbInput.knowledgeBaseId) {
    throw new ToolValidationError(
      "Knowledge Base Retrieve tool requires a 'knowledgeBaseId' parameter",
      'kb-retrieve',
      'knowledgeBaseId'
    );
  }

  if (!kbInput.query) {
    throw new ToolValidationError(
      "Knowledge Base Retrieve tool requires a 'query' parameter",
      'kb-retrieve',
      'query'
    );
  }

  const knowledgeBaseId = kbInput.knowledgeBaseId;
  const query = kbInput.query;
  const numberOfResults = kbInput.numberOfResults || 5;

  logger.info('KB_RETRIEVE_START', {
    knowledgeBaseId,
    query: query.substring(0, 100), // Truncate for logging
    numberOfResults,
  });

  try {
    // Execute retrieval from Bedrock Knowledge Base
    const command = new RetrieveCommand({
      knowledgeBaseId: knowledgeBaseId,
      retrievalQuery: {
        text: query,
      },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: numberOfResults,
        },
      },
    });

    const response = await bedrockClient.send(command);

    // Process the response
    const retrievalResults = response.retrievalResults || [];
    const retrievedChunks = retrievalResults.map((result) => ({
      content: result.content?.text || '',
      score: result.score,
      location: result.location
        ? {
            type: result.location.type || 'UNKNOWN',
            uri: result.location.s3Location?.uri,
          }
        : undefined,
      metadata: result.metadata || {},
    }));

    logger.info('KB_RETRIEVE_SUCCESS', {
      knowledgeBaseId,
      totalChunks: retrievedChunks.length,
      averageScore:
        retrievedChunks.length > 0
          ? retrievedChunks.reduce((sum, chunk) => sum + (chunk.score || 0), 0) /
            retrievedChunks.length
          : 0,
      hasResults: retrievedChunks.length > 0,
    });

    const result: KbRetrieveResult = {
      retrievedChunks,
      totalCount: retrievedChunks.length,
      knowledgeBaseId,
      query,
    };

    return result;
  } catch (error) {
    logger.error('KB_RETRIEVE_ERROR', {
      knowledgeBaseId,
      query: query.substring(0, 100),
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });

    throw error;
  }
}

/**
 * Knowledge Base Retrieve tool definition
 */
export const kbRetrieveTool: Tool = {
  name: 'retrieve',
  handler: handleKbRetrieve,
  description: 'Retrieve relevant chunks from Amazon Bedrock Knowledge Base using semantic search',
  version: '1.0.0',
  tags: ['knowledge-base', 'search', 'retrieval', 'bedrock'],
};

export default kbRetrieveTool;
