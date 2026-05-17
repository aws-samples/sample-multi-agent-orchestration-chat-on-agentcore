/**
 * Agent Management Service
 * Manages user Agents using DynamoDB
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall, NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import type { UserId, AgentId } from '@moca/core';
import { config } from '../config/index.js';
import { SsmEnvStore } from './ssm-env-store.js';
import {
  extractEnvFromMcpConfig,
  restoreEnvToMcpConfig,
  stripEnvFromMcpConfig,
  hasSsmSentinel,
} from './mcp-env-helpers.js';
import type {
  MCPConfig,
  Agent,
  DynamoAgent,
  CreateAgentInput,
  UpdateAgentInput,
  PaginatedResult,
} from '../types/index.js';
import { logger } from '../libs/logger/index.js';

// Re-export types for backward compatibility
export type {
  MCPServer,
  MCPConfig,
  Scenario,
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  PaginatedResult,
} from '../types/index.js';

/**
 * Convert Agent to DynamoDB storage format
 */
function toDynamoAgent(agent: Agent): DynamoAgent {
  return {
    ...agent,
    isShared: agent.isShared ? 'true' : 'false',
  };
}

/**
 * Convert Agent retrieved from DynamoDB to application format
 */
function fromDynamoAgent(dynamoAgent: DynamoAgent): Agent {
  return {
    ...dynamoAgent,
    isShared: dynamoAgent.isShared === 'true',
  };
}

/**
 * Agent management service class
 */
export class AgentsService {
  private dynamoClient: DynamoDBClient;
  private tableName: string;
  private ssmEnvStore: SsmEnvStore;

  constructor(tableName: string, ssmParameterPrefix: string, region?: string) {
    this.tableName = tableName;
    this.dynamoClient = new DynamoDBClient({ region: region || config.AWS_REGION });
    this.ssmEnvStore = new SsmEnvStore(ssmParameterPrefix, region);
  }

  /**
   * Get list of Agents for a user
   * Uses internal pagination to ensure all agents are retrieved
   * (DynamoDB Query has a 1MB limit per request)
   */
  async listAgents(userId: UserId): Promise<Agent[]> {
    try {
      const allItems: Agent[] = [];
      let exclusiveStartKey: Record<string, AttributeValue> | undefined;

      do {
        const command = new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: marshall({
            ':userId': userId,
          }),
          ExclusiveStartKey: exclusiveStartKey,
        });

        const response = await this.dynamoClient.send(command);

        if (response.Items && response.Items.length > 0) {
          allItems.push(
            ...response.Items.map((item) => fromDynamoAgent(unmarshall(item) as DynamoAgent))
          );
        }

        exclusiveStartKey = response.LastEvaluatedKey;
      } while (exclusiveStartKey);

      return allItems;
    } catch (error) {
      logger.error({ err: error }, 'Error listing agents:');
      throw new Error('Failed to list agents', { cause: error });
    }
  }

  /**
   * Get a specific Agent (with env values resolved from SSM if available)
   */
  async getAgent(userId: UserId, agentId: AgentId): Promise<Agent | null> {
    try {
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({
          userId,
          agentId,
        }),
      });

      const response = await this.dynamoClient.send(command);

      if (!response.Item) {
        return null;
      }

      // Convert data retrieved from DynamoDB to Agent type
      const agent = fromDynamoAgent(unmarshall(response.Item) as DynamoAgent);

      // Resolve env values from SSM if sentinel is present
      if (agent.mcpConfig && hasSsmSentinel(agent.mcpConfig)) {
        const envMap = await this.ssmEnvStore.get(userId, agentId);
        if (envMap) {
          agent.mcpConfig = restoreEnvToMcpConfig(agent.mcpConfig, envMap);
        }
      }

      return agent;
    } catch (error) {
      logger.error({ err: error }, 'Error getting agent:');
      throw new Error('Failed to get agent', { cause: error });
    }
  }

  /**
   * Get a specific Agent without resolving SSM env values (raw DynamoDB data).
   * Used internally when env resolution is not needed (e.g. for shared agents, cloning).
   */
  private async getAgentRaw(userId: UserId, agentId: AgentId): Promise<Agent | null> {
    try {
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({
          userId,
          agentId,
        }),
      });

      const response = await this.dynamoClient.send(command);

      if (!response.Item) {
        return null;
      }

      return fromDynamoAgent(unmarshall(response.Item) as DynamoAgent);
    } catch (error) {
      logger.error({ err: error }, 'Error getting agent (raw):');
      throw new Error('Failed to get agent', { cause: error });
    }
  }

  /**
   * Create a new Agent
   */
  async createAgent(userId: UserId, input: CreateAgentInput, username?: string): Promise<Agent> {
    try {
      const now = new Date().toISOString();
      const agentId = uuidv7() as AgentId;

      // Extract env values and store in SSM
      let mcpConfigForDb = input.mcpConfig;
      let originalMcpConfig = input.mcpConfig;

      if (input.mcpConfig) {
        const { sanitizedConfig, envMap } = extractEnvFromMcpConfig(input.mcpConfig);
        if (envMap) {
          await this.ssmEnvStore.save(userId, agentId, envMap);
          mcpConfigForDb = sanitizedConfig;
          originalMcpConfig = input.mcpConfig;
        }
      }

      const agent: Agent = {
        userId,
        agentId,
        name: input.name,
        description: input.description,
        icon: input.icon,
        systemPrompt: input.systemPrompt,
        enabledTools: input.enabledTools,
        scenarios: input.scenarios.map((scenario) => ({
          ...scenario,
          id: uuidv7(),
        })),
        mcpConfig: mcpConfigForDb,
        defaultStoragePath: input.defaultStoragePath,
        createdAt: now,
        updatedAt: now,
        isShared: false, // Default to private
        createdBy: username || userId, // Use userId if username is not available
      };

      // Convert to DynamoDB storage format (stringify isShared)
      const dynamoAgent = toDynamoAgent(agent);

      const command = new PutItemCommand({
        TableName: this.tableName,
        Item: marshall(dynamoAgent, { removeUndefinedValues: true }),
      });

      await this.dynamoClient.send(command);

      // Return agent with the original (unmasked) env values
      return { ...agent, mcpConfig: originalMcpConfig };
    } catch (error) {
      logger.error({ err: error }, 'Error creating agent:');
      throw new Error('Failed to create agent', { cause: error });
    }
  }

  /**
   * Update an Agent
   */
  async updateAgent(userId: UserId, input: UpdateAgentInput): Promise<Agent> {
    try {
      // Retrieve existing Agent
      const existingAgent = await this.getAgent(userId, input.agentId);

      if (!existingAgent) {
        throw new Error('Agent not found');
      }

      const now = new Date().toISOString();

      // Build the attributes to update
      const updateExpressions: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, NativeAttributeValue> = {};

      if (input.name !== undefined) {
        updateExpressions.push('#name = :name');
        expressionAttributeNames['#name'] = 'name';
        expressionAttributeValues[':name'] = input.name;
      }

      if (input.description !== undefined) {
        updateExpressions.push('#description = :description');
        expressionAttributeNames['#description'] = 'description';
        expressionAttributeValues[':description'] = input.description;
      }

      if (input.icon !== undefined) {
        updateExpressions.push('#icon = :icon');
        expressionAttributeNames['#icon'] = 'icon';
        expressionAttributeValues[':icon'] = input.icon;
      }

      if (input.systemPrompt !== undefined) {
        updateExpressions.push('#systemPrompt = :systemPrompt');
        expressionAttributeNames['#systemPrompt'] = 'systemPrompt';
        expressionAttributeValues[':systemPrompt'] = input.systemPrompt;
      }

      if (input.enabledTools !== undefined) {
        updateExpressions.push('#enabledTools = :enabledTools');
        expressionAttributeNames['#enabledTools'] = 'enabledTools';
        expressionAttributeValues[':enabledTools'] = input.enabledTools;
      }

      if (input.scenarios !== undefined) {
        const scenariosWithIds = input.scenarios.map((scenario) => ({
          ...scenario,
          id: uuidv7(),
        }));
        updateExpressions.push('#scenarios = :scenarios');
        expressionAttributeNames['#scenarios'] = 'scenarios';
        expressionAttributeValues[':scenarios'] = scenariosWithIds;
      }

      if (input.mcpConfig !== undefined) {
        // Extract env values and store in SSM
        let mcpConfigForDb: MCPConfig | undefined = input.mcpConfig;

        if (input.mcpConfig) {
          const { sanitizedConfig, envMap } = extractEnvFromMcpConfig(input.mcpConfig);
          if (envMap) {
            await this.ssmEnvStore.save(userId, input.agentId, envMap);
            mcpConfigForDb = sanitizedConfig;
          } else {
            // No env values — clean up any existing SSM parameter
            await this.ssmEnvStore.delete(userId, input.agentId).catch(() => {});
          }
        }

        updateExpressions.push('#mcpConfig = :mcpConfig');
        expressionAttributeNames['#mcpConfig'] = 'mcpConfig';
        expressionAttributeValues[':mcpConfig'] = mcpConfigForDb;
      }

      // Handle defaultStoragePath: empty string means remove, other values update
      const removeExpressions: string[] = [];
      if (input.defaultStoragePath !== undefined) {
        if (input.defaultStoragePath === '') {
          // Empty string means clear the attribute
          removeExpressions.push('#defaultStoragePath');
          expressionAttributeNames['#defaultStoragePath'] = 'defaultStoragePath';
        } else {
          updateExpressions.push('#defaultStoragePath = :defaultStoragePath');
          expressionAttributeNames['#defaultStoragePath'] = 'defaultStoragePath';
          expressionAttributeValues[':defaultStoragePath'] = input.defaultStoragePath;
        }
      }

      // updatedAt is always updated
      updateExpressions.push('#updatedAt = :updatedAt');
      expressionAttributeNames['#updatedAt'] = 'updatedAt';
      expressionAttributeValues[':updatedAt'] = now;

      // Build UpdateExpression with SET and optional REMOVE
      let updateExpression = `SET ${updateExpressions.join(', ')}`;
      if (removeExpressions.length > 0) {
        updateExpression += ` REMOVE ${removeExpressions.join(', ')}`;
      }

      const command = new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({
          userId,
          agentId: input.agentId,
        }),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, {
          removeUndefinedValues: true,
        }),
        ReturnValues: 'ALL_NEW',
      });

      const response = await this.dynamoClient.send(command);

      if (!response.Attributes) {
        throw new Error('Failed to update agent');
      }

      // Convert data retrieved from DynamoDB to Agent type
      return fromDynamoAgent(unmarshall(response.Attributes) as DynamoAgent);
    } catch (error) {
      logger.error({ err: error }, 'Error updating agent:');
      throw error;
    }
  }

  /**
   * Delete an Agent
   */
  async deleteAgent(userId: UserId, agentId: AgentId): Promise<void> {
    try {
      // Delete SSM parameter (best-effort)
      await this.ssmEnvStore.delete(userId, agentId).catch((err) => {
        logger.warn({ err: err }, 'Failed to delete SSM parameter for agent, continuing:');
      });

      const command = new DeleteItemCommand({
        TableName: this.tableName,
        Key: marshall({
          userId,
          agentId,
        }),
      });

      await this.dynamoClient.send(command);
    } catch (error) {
      logger.error({ err: error }, 'Error deleting agent:');
      throw new Error('Failed to delete agent', { cause: error });
    }
  }

  /**
   * Initialize default Agents
   * Called when a user logs in for the first time
   */
  async initializeDefaultAgents(
    userId: UserId,
    defaultAgents: CreateAgentInput[],
    username?: string
  ): Promise<Agent[]> {
    try {
      const createdAgents: Agent[] = [];

      for (const agentInput of defaultAgents) {
        const agent = await this.createAgent(userId, agentInput, username);
        createdAgents.push(agent);
      }

      return createdAgents;
    } catch (error) {
      logger.error({ err: error }, 'Error initializing default agents:');
      throw new Error('Failed to initialize default agents', { cause: error });
    }
  }

  /**
   * Toggle the sharing state of an Agent
   */
  async toggleShare(userId: UserId, agentId: AgentId): Promise<Agent> {
    try {
      const existingAgent = await this.getAgent(userId, agentId);

      if (!existingAgent) {
        throw new Error('Agent not found');
      }

      const now = new Date().toISOString();
      const newIsShared = !existingAgent.isShared;
      // Convert to string for DynamoDB GSI
      const newIsSharedStr = newIsShared ? 'true' : 'false';

      const command = new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({
          userId,
          agentId,
        }),
        UpdateExpression: 'SET #isShared = :isShared, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#isShared': 'isShared',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: marshall({
          ':isShared': newIsSharedStr,
          ':updatedAt': now,
        }),
        ReturnValues: 'ALL_NEW',
      });

      const response = await this.dynamoClient.send(command);

      if (!response.Attributes) {
        throw new Error('Failed to toggle share');
      }

      // Convert data retrieved from DynamoDB to Agent type
      return fromDynamoAgent(unmarshall(response.Attributes) as DynamoAgent);
    } catch (error) {
      logger.error({ err: error }, 'Error toggling share:');
      throw error;
    }
  }

  /**
   * Get list of shared Agents (with pagination support)
   */
  async listSharedAgents(
    limit: number = 20,
    searchQuery?: string,
    cursor?: string
  ): Promise<PaginatedResult<Agent>> {
    try {
      // Decode cursor
      let exclusiveStartKey: Record<string, AttributeValue> | undefined;
      if (cursor) {
        try {
          const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
          exclusiveStartKey = JSON.parse(decoded);
        } catch (error) {
          logger.error({ err: error }, 'Invalid cursor format:');
          throw new Error('Invalid pagination cursor', { cause: error });
        }
      }

      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: 'isShared-createdAt-index',
        KeyConditionExpression: '#isShared = :isShared',
        ExpressionAttributeNames: {
          '#isShared': 'isShared',
        },
        ExpressionAttributeValues: marshall({
          ':isShared': 'true',
        }),
        ScanIndexForward: false, // Newest first
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey ? marshall(exclusiveStartKey) : undefined,
      });

      const response = await this.dynamoClient.send(command);

      if (!response.Items || response.Items.length === 0) {
        return {
          items: [],
          hasMore: false,
        };
      }

      // Convert data retrieved from DynamoDB to Agent type
      let agents = response.Items.map((item) => fromDynamoAgent(unmarshall(item) as DynamoAgent));

      // Filter by name if search query is provided
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        agents = agents.filter((agent) => agent.name.toLowerCase().includes(query));
      }

      // Encode next cursor
      let nextCursor: string | undefined;
      if (response.LastEvaluatedKey) {
        const unmarshalled = unmarshall(response.LastEvaluatedKey);
        nextCursor = Buffer.from(JSON.stringify(unmarshalled)).toString('base64');
      }

      return {
        items: agents,
        nextCursor,
        hasMore: !!response.LastEvaluatedKey,
      };
    } catch (error) {
      logger.error({ err: error }, 'Error listing shared agents:');
      throw error instanceof Error ? error : new Error('Failed to list shared agents');
    }
  }

  /**
   * Get a shared Agent (from any user).
   * Env values are stripped for security — non-owners must not see secrets.
   */
  async getSharedAgent(userId: UserId, agentId: AgentId): Promise<Agent | null> {
    try {
      // Use raw read (no SSM resolution) since we strip env anyway
      const agent = await this.getAgentRaw(userId, agentId);

      if (!agent || !agent.isShared) {
        return null;
      }

      // Strip env values from mcpConfig for security
      if (agent.mcpConfig) {
        agent.mcpConfig = stripEnvFromMcpConfig(agent.mcpConfig);
      }

      return agent;
    } catch (error) {
      logger.error({ err: error }, 'Error getting shared agent:');
      throw new Error('Failed to get shared agent', { cause: error });
    }
  }

  /**
   * Clone a shared Agent into your own collection.
   * Env values are NOT copied — the target user must provide their own credentials.
   */
  async cloneAgent(
    targetUserId: UserId,
    sourceUserId: UserId,
    sourceAgentId: AgentId,
    targetUsername?: string
  ): Promise<Agent> {
    try {
      // Retrieve the original Agent (env already stripped by getSharedAgent)
      const sourceAgent = await this.getSharedAgent(sourceUserId, sourceAgentId);

      if (!sourceAgent) {
        throw new Error('Shared agent not found');
      }

      // Create as a new Agent — mcpConfig already has env stripped
      const input: CreateAgentInput = {
        name: sourceAgent.name,
        description: sourceAgent.description,
        icon: sourceAgent.icon,
        systemPrompt: sourceAgent.systemPrompt,
        enabledTools: sourceAgent.enabledTools,
        scenarios: sourceAgent.scenarios.map((s) => ({
          title: s.title,
          prompt: s.prompt,
        })),
        mcpConfig: sourceAgent.mcpConfig,
        defaultStoragePath: sourceAgent.defaultStoragePath,
      };

      return await this.createAgent(targetUserId, input, targetUsername);
    } catch (error) {
      logger.error({ err: error }, 'Error cloning agent:');
      throw error;
    }
  }
}

/**
 * Create an AgentsService instance
 */
export function createAgentsService(): AgentsService {
  return new AgentsService(
    config.AGENTS_TABLE_NAME,
    config.SSM_PARAMETER_PREFIX,
    config.AWS_REGION
  );
}
