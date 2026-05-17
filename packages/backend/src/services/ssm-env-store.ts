/**
 * SSM Parameter Store-based secure storage for MCP Config env values.
 *
 * Each agent's env map is stored as a single SSM SecureString parameter:
 *   /agentcore/{resourcePrefix}/agents/{userId}/{agentId}/mcp-env
 *
 * The parameter value is a JSON object:
 *   Record<serverName, Record<envKey, envValue>>
 */

import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
  DeleteParameterCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import type { UserId, AgentId } from '@moca/core';
import { config } from '../config/index.js';

/** Nested env map: serverName → { envKey: envValue } */
export type McpEnvMap = Record<string, Record<string, string>>;

/** Sentinel object stored in DynamoDB when env values are in SSM */
export const SSM_SENTINEL = { __ssm: true } as const;

/**
 * Check whether an env object is the SSM sentinel marker.
 */
export function isSsmSentinel(env: unknown): boolean {
  if (env == null || typeof env !== 'object') return false;
  return (env as Record<string, unknown>).__ssm === true;
}

/**
 * Manages MCP env values in AWS Systems Manager Parameter Store.
 */
export class SsmEnvStore {
  private client: SSMClient;
  private parameterPrefix: string;

  /**
   * @param parameterPrefix  e.g. "/agentcore/mocadev"
   * @param region           AWS region (falls back to AWS_REGION env var)
   */
  constructor(parameterPrefix: string, region?: string) {
    this.parameterPrefix = parameterPrefix;
    this.client = new SSMClient({ region: region || config.AWS_REGION });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Save (create or overwrite) env values as a SecureString parameter.
   */
  async save(userId: UserId, agentId: AgentId, envMap: McpEnvMap): Promise<void> {
    const name = this.getParameterName(userId, agentId);

    await this.client.send(
      new PutParameterCommand({
        Name: name,
        Value: JSON.stringify(envMap),
        Type: 'SecureString',
        Overwrite: true,
        Description: `MCP env for agent agentId: ${agentId} owned by userId: ${userId}`,
      })
    );
  }

  /**
   * Retrieve and decrypt the env values.
   * Returns `null` when the parameter does not exist.
   */
  async get(userId: UserId, agentId: AgentId): Promise<McpEnvMap | null> {
    const name = this.getParameterName(userId, agentId);

    try {
      const response = await this.client.send(
        new GetParameterCommand({
          Name: name,
          WithDecryption: true,
        })
      );

      if (!response.Parameter?.Value) return null;
      return JSON.parse(response.Parameter.Value) as McpEnvMap;
    } catch (error: unknown) {
      if (error instanceof ParameterNotFound) return null;
      // AWS SDK v3 may also use error name
      if (error instanceof Error && error.name === 'ParameterNotFound') return null;
      throw error;
    }
  }

  /**
   * Delete the env parameter. Silently ignores ParameterNotFound.
   */
  async delete(userId: UserId, agentId: AgentId): Promise<void> {
    const name = this.getParameterName(userId, agentId);

    try {
      await this.client.send(new DeleteParameterCommand({ Name: name }));
    } catch (error: unknown) {
      if (error instanceof ParameterNotFound) return;
      if (error instanceof Error && error.name === 'ParameterNotFound') return;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private getParameterName(userId: UserId, agentId: AgentId): string {
    return `${this.parameterPrefix}/agents/${userId}/${agentId}/mcp-env`;
  }
}
