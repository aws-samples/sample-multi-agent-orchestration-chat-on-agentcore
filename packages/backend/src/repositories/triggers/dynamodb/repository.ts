/**
 * `DynamoDBTriggersRepository` — the DynamoDB-backed {@link TriggersRepository}.
 *
 * IMPLEMENTATION DETAIL. Callers depend on the `TriggersRepository` interface
 * (see `../triggers-repository.ts`) and obtain an instance from the factory;
 * they never import this class directly.
 *
 * The module is intentionally free of any dependency on `config/index.ts`: the
 * `DynamoDBClient` and table name are injected via the constructor (DI). That
 * keeps it integration-testable against DynamoDB Local without tripping the
 * config module's env validation / `process.exit`. All single-table key/index
 * knowledge lives in `./item.ts`, not here.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import type { UserId, TriggerId } from '@moca/core';
import { logger } from '../../../libs/logger/index.js';
import type {
  TriggersRepository,
  CreateTriggerInput,
  UpdateTriggerInput,
  ListTriggersOptions,
  ListTriggersResult,
  GetExecutionsResult,
} from '../triggers-repository.js';
import { MAX_TRIGGERS_PER_USER, TriggerLimitExceededError, type Trigger } from '../types.js';
import {
  buildUpdateExpression,
  triggerKeyAttr,
  userTriggersQueryValues,
  listTriggersQueryValues,
  executionsQueryValues,
  eventSourceQueryValues,
  toItemAttr,
  toUpdateValuesAttr,
  fromItemAttr,
  fromExecutionItemAttr,
  fromLastEvaluatedKey,
  toExclusiveStartKey,
} from './item.js';

export class DynamoDBTriggersRepository implements TriggersRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(client: DynamoDBClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  isConfigured(): boolean {
    return !!this.tableName;
  }

  async countTriggers(userId: UserId): Promise<number> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: userTriggersQueryValues(userId),
        Select: 'COUNT',
      })
    );
    return result.Count ?? 0;
  }

  async createTrigger(input: CreateTriggerInput): Promise<Trigger> {
    // Enforce the per-user hard limit before writing. Throws
    // TriggerLimitExceededError (→ 409) when the user is already at capacity.
    //
    // NOTE: this count-then-write is not atomic — two highly-concurrent creates
    // by the same user could each observe count < MAX and both write, briefly
    // exceeding the limit by a small margin. That window is accepted: the
    // overshoot is self-healing (the user can delete back under the limit) and
    // a fully atomic guard (counter item / TransactWrite) would add derived
    // state that can itself drift. The PutItem below is still made conditional
    // so a UUID collision can never silently overwrite an existing trigger.
    const existingCount = await this.countTriggers(input.userId);
    if (existingCount >= MAX_TRIGGERS_PER_USER) {
      throw new TriggerLimitExceededError();
    }

    const triggerId = uuidv7() as TriggerId;
    const now = new Date().toISOString();

    const trigger: Trigger = {
      id: triggerId,
      userId: input.userId,
      name: input.name,
      description: input.description,
      type: input.type,
      enabled: true,
      agentId: input.agentId,
      prompt: input.prompt,
      sessionId: input.sessionId,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      workingDirectory: input.workingDirectory,
      enabledTools: input.enabledTools,
      scheduleConfig: input.scheduleConfig,
      eventConfig: input.eventConfig,
      createdAt: now,
      updatedAt: now,
    };

    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: toItemAttr(trigger),
        // Never overwrite an existing item: the (PK, SK) pair must be new.
        // Guards against an astronomically unlikely UUIDv7 collision silently
        // clobbering another trigger.
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      })
    );

    logger.info({ triggerId, userId: input.userId, name: input.name }, 'Trigger created:');
    return trigger;
  }

  async getTrigger(userId: UserId, triggerId: TriggerId): Promise<Trigger | null> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: triggerKeyAttr(userId, triggerId),
      })
    );

    if (!result.Item) {
      return null;
    }

    return fromItemAttr(result.Item);
  }

  async listTriggers(
    userId: UserId,
    options: ListTriggersOptions = {}
  ): Promise<ListTriggersResult> {
    const { limit, type, exclusiveStartKey } = options;

    // Optional `type` filter. FilterExpression is applied AFTER the Limit, so
    // a page may contain fewer than `limit` items even when more pages exist;
    // callers paginate on lastEvaluatedKey, not on item count.
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: type ? '#type = :type' : undefined,
        ExpressionAttributeNames: type ? { '#type': 'type' } : undefined,
        ExpressionAttributeValues: listTriggersQueryValues(userId, type),
        Limit: limit,
        ExclusiveStartKey: toExclusiveStartKey(exclusiveStartKey),
      })
    );

    return {
      triggers: result.Items ? result.Items.map(fromItemAttr) : [],
      lastEvaluatedKey: fromLastEvaluatedKey(result.LastEvaluatedKey),
    };
  }

  async updateTrigger(
    userId: UserId,
    triggerId: TriggerId,
    updates: UpdateTriggerInput
  ): Promise<Trigger> {
    const now = new Date().toISOString();

    // Get existing trigger to check for type changes
    const existingTrigger = await this.getTrigger(userId, triggerId);
    if (!existingTrigger) {
      throw new Error('Trigger not found');
    }

    const { updateExpression, attributeNames, attributeValues } = buildUpdateExpression(
      userId,
      triggerId,
      updates,
      existingTrigger,
      now
    );

    const result = await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: triggerKeyAttr(userId, triggerId),
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: toUpdateValuesAttr(attributeValues),
        ...(Object.keys(attributeNames).length > 0
          ? { ExpressionAttributeNames: attributeNames }
          : {}),
        // Return the post-update item in the same call, avoiding a second
        // round-trip GetItem just to read back what we wrote.
        ReturnValues: 'ALL_NEW',
      })
    );

    logger.info({ triggerId, userId, typeChanged: updates.type !== undefined }, 'Trigger updated:');

    if (!result.Attributes) {
      throw new Error('Failed to retrieve updated trigger');
    }
    return fromItemAttr(result.Attributes);
  }

  async deleteTrigger(userId: UserId, triggerId: TriggerId): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: triggerKeyAttr(userId, triggerId),
      })
    );

    logger.info({ triggerId, userId }, 'Trigger deleted:');
  }

  async listTriggersByEventSource(eventSourceId: string): Promise<Trigger[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: eventSourceQueryValues(eventSourceId),
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return [];
    }

    return result.Items.map(fromItemAttr);
  }

  async getExecutions(
    triggerId: TriggerId,
    limit: number = 20,
    exclusiveStartKey?: Record<string, unknown>
  ): Promise<GetExecutionsResult> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: executionsQueryValues(triggerId),
        Limit: limit,
        ScanIndexForward: false, // Most recent first
        ExclusiveStartKey: toExclusiveStartKey(exclusiveStartKey),
      })
    );

    return {
      executions: result.Items ? result.Items.map(fromExecutionItemAttr) : [],
      lastEvaluatedKey: fromLastEvaluatedKey(result.LastEvaluatedKey),
    };
  }
}
