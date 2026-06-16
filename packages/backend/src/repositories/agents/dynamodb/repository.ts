/**
 * `DynamoDBAgentsRepository` — the DynamoDB-backed {@link AgentsRepository}.
 *
 * IMPLEMENTATION DETAIL. Callers depend on the `AgentsRepository` interface (see
 * `../agents-repository.ts`) and obtain an instance from the factory; they never
 * import this class directly.
 *
 * The module is intentionally free of any dependency on `config/index.ts`: the
 * `DynamoDBClient` and table name are injected via the constructor (DI), so it
 * stays integration-testable against DynamoDB Local. All key/marshalling/GSI
 * knowledge lives in `./item.ts`, not here.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { UserId, AgentId } from '@moca/core';
import { logger } from '../../../libs/logger/index.js';
import { AgentNotFoundError, type Agent } from '../../../types/index.js';
import type {
  AgentsRepository,
  UpdateAgentPatch,
  SharedAgentsPage,
} from '../agents-repository.js';
import {
  agentKeyAttr,
  toItemAttr,
  fromItemAttr,
  buildAgentUpdateExpression,
} from './item.js';

const SHARED_INDEX = 'isShared-createdAt-index';

export class DynamoDBAgentsRepository implements AgentsRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(client: DynamoDBClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  async listByUser(userId: UserId): Promise<Agent[]> {
    const agents: Agent[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    // DynamoDB Query caps at 1MB/page; loop until the user's partition is drained.
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: marshall({ ':userId': userId }),
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      if (response.Items) {
        agents.push(...response.Items.map(fromItemAttr));
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return agents;
  }

  async get(userId: UserId, agentId: AgentId): Promise<Agent | null> {
    const response = await this.client.send(
      new GetItemCommand({ TableName: this.tableName, Key: agentKeyAttr(userId, agentId) })
    );
    return response.Item ? fromItemAttr(response.Item) : null;
  }

  async put(agent: Agent): Promise<void> {
    await this.client.send(
      new PutItemCommand({ TableName: this.tableName, Item: toItemAttr(agent) })
    );
  }

  async update(userId: UserId, agentId: AgentId, patch: UpdateAgentPatch): Promise<Agent> {
    const now = new Date().toISOString();
    const { updateExpression, attributeNames, attributeValues } = buildAgentUpdateExpression(
      patch,
      now
    );

    const response = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: agentKeyAttr(userId, agentId),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: marshall(attributeValues, { removeUndefinedValues: true }),
        // Only update an agent that exists — otherwise UpdateItem would upsert a
        // partial row. A failed condition surfaces as AgentNotFoundError below.
        ConditionExpression: 'attribute_exists(userId) AND attribute_exists(agentId)',
        ReturnValues: 'ALL_NEW',
      })
    ).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        throw new AgentNotFoundError();
      }
      throw error;
    });

    if (!response.Attributes) {
      throw new Error('Failed to retrieve updated agent');
    }
    logger.info({ agentId, userId }, 'Agent updated:');
    return fromItemAttr(response.Attributes);
  }

  async toggleShare(userId: UserId, agentId: AgentId): Promise<Agent> {
    const existing = await this.get(userId, agentId);
    if (!existing) {
      throw new AgentNotFoundError();
    }

    const now = new Date().toISOString();
    const response = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: agentKeyAttr(userId, agentId),
        UpdateExpression: 'SET #isShared = :isShared, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#isShared': 'isShared', '#updatedAt': 'updatedAt' },
        // isShared is stored as a string for the GSI key (see item.ts).
        ExpressionAttributeValues: marshall({
          ':isShared': existing.isShared ? 'false' : 'true',
          ':updatedAt': now,
        }),
        // Guard against the get→update TOCTOU window: if the row was deleted
        // after the read above, an unconditional UpdateItem would upsert a
        // partial row back into existence. Mirror update()'s existence check.
        ConditionExpression: 'attribute_exists(userId) AND attribute_exists(agentId)',
        ReturnValues: 'ALL_NEW',
      })
    ).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        throw new AgentNotFoundError();
      }
      throw error;
    });

    if (!response.Attributes) {
      throw new Error('Failed to retrieve updated agent');
    }
    return fromItemAttr(response.Attributes);
  }

  async delete(userId: UserId, agentId: AgentId): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({ TableName: this.tableName, Key: agentKeyAttr(userId, agentId) })
    );
  }

  async listShared(
    limit: number,
    exclusiveStartKey?: Record<string, unknown>
  ): Promise<SharedAgentsPage> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: SHARED_INDEX,
        KeyConditionExpression: '#isShared = :isShared',
        ExpressionAttributeNames: { '#isShared': 'isShared' },
        ExpressionAttributeValues: marshall({ ':isShared': 'true' }),
        ScanIndexForward: false, // Newest first
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
          ? (marshall(exclusiveStartKey) as Record<string, AttributeValue>)
          : undefined,
      })
    );

    return {
      agents: response.Items ? response.Items.map(fromItemAttr) : [],
      lastEvaluatedKey: response.LastEvaluatedKey ? unmarshall(response.LastEvaluatedKey) : undefined,
    };
  }
}
