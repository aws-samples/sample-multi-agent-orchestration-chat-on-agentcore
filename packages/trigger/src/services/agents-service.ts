/**
 * Agent management service for Trigger package
 * Provides read-only access to Agent data from DynamoDB
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SSMClient, GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('AgentsService');

export interface MCPServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServer>;
}

export interface Scenario {
  id: string;
  title: string;
  prompt: string;
}

export interface Agent {
  userId: string;
  agentId: string;
  name: string;
  description: string;
  icon?: string;
  systemPrompt: string;
  enabledTools: string[];
  scenarios: Scenario[];
  mcpConfig?: MCPConfig;
  createdAt: string;
  updatedAt: string;
  isShared: boolean;
  createdBy: string;
}

/**
 * DynamoDB storage format for Agent
 * isShared is stored as string for GSI key constraints
 */
interface DynamoAgent extends Omit<Agent, 'isShared'> {
  isShared: string; // 'true' | 'false'
}

/**
 * Convert DynamoDB Agent to application Agent
 */
function fromDynamoAgent(dynamoAgent: DynamoAgent): Agent {
  return {
    ...dynamoAgent,
    isShared: dynamoAgent.isShared === 'true',
  };
}

/**
 * Check whether an env object is the SSM sentinel marker.
 */
function isSsmSentinel(env: unknown): boolean {
  if (env == null || typeof env !== 'object') return false;
  return (env as Record<string, unknown>).__ssm === true;
}

/**
 * Check whether any server in the mcpConfig has the SSM sentinel.
 */
function hasSsmSentinel(mcpConfig: MCPConfig): boolean {
  return Object.values(mcpConfig.mcpServers).some((server) => isSsmSentinel(server.env));
}

/**
 * Restore env values from an envMap into an mcpConfig that has SSM sentinels.
 */
function restoreEnvToMcpConfig(
  mcpConfig: MCPConfig,
  envMap: Record<string, Record<string, string>>
): MCPConfig {
  const restoredServers: Record<string, MCPServer> = {};

  for (const [serverName, server] of Object.entries(mcpConfig.mcpServers)) {
    if (isSsmSentinel(server.env) && envMap[serverName]) {
      restoredServers[serverName] = {
        ...server,
        env: { ...envMap[serverName] },
      };
    } else {
      restoredServers[serverName] = { ...server };
    }
  }

  return { mcpServers: restoredServers };
}

/**
 * Agent management service class
 */
export class AgentsService {
  private dynamoClient: DynamoDBClient;
  private tableName: string;
  private ssmClient: SSMClient;
  private ssmParameterPrefix: string;

  constructor(tableName: string, ssmParameterPrefix: string, region?: string) {
    this.tableName = tableName;
    this.dynamoClient = new DynamoDBClient({ region: region || process.env.AWS_REGION });
    this.ssmParameterPrefix = ssmParameterPrefix;
    this.ssmClient = new SSMClient({ region: region || process.env.AWS_REGION });
  }

  /**
   * Get specific Agent
   */
  async getAgent(userId: string, agentId: string): Promise<Agent | null> {
    try {
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: {
          userId: { S: userId },
          agentId: { S: agentId },
        },
      });

      const response = await this.dynamoClient.send(command);

      if (!response.Item) {
        return null;
      }

      // Convert DynamoDB data to Agent type
      const agent = fromDynamoAgent(unmarshall(response.Item) as DynamoAgent);

      // Resolve env values from SSM if sentinel is present
      if (agent.mcpConfig && hasSsmSentinel(agent.mcpConfig)) {
        try {
          const paramName = `${this.ssmParameterPrefix}/agents/${userId}/${agentId}/mcp-env`;
          const ssmResponse = await this.ssmClient.send(
            new GetParameterCommand({ Name: paramName, WithDecryption: true })
          );
          if (ssmResponse.Parameter?.Value) {
            const envMap = JSON.parse(ssmResponse.Parameter.Value) as Record<
              string,
              Record<string, string>
            >;
            agent.mcpConfig = restoreEnvToMcpConfig(agent.mcpConfig, envMap);
          }
        } catch (ssmError: unknown) {
          if (
            ssmError instanceof ParameterNotFound ||
            (ssmError instanceof Error && ssmError.name === 'ParameterNotFound')
          ) {
            log.warn('SSM parameter not found for agent MCP env, continuing with sentinel');
          } else {
            log.warn({ err: ssmError }, 'Failed to resolve MCP env from SSM');
          }
        }
      }

      return agent;
    } catch (error) {
      log.error({ err: error }, 'Error getting agent');
      throw new Error('Failed to get agent', { cause: error });
    }
  }
}

/**
 * Create AgentsService instance
 */
export function createAgentsService(): AgentsService {
  const tableName = process.env.AGENTS_TABLE_NAME;
  const region = process.env.AWS_REGION;
  const ssmParameterPrefix = process.env.SSM_PARAMETER_PREFIX;

  if (!tableName) {
    throw new Error('AGENTS_TABLE_NAME environment variable is not set');
  }

  if (!ssmParameterPrefix) {
    throw new Error('SSM_PARAMETER_PREFIX environment variable is not set');
  }

  return new AgentsService(tableName, ssmParameterPrefix, region);
}
