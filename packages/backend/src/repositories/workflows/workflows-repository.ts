import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { UserId } from '@moca/core';
import {
  workflowKeys,
  workflowTtl,
  type WorkflowRecord,
  type WorkflowStepState,
} from '@moca/tool-definitions';

type Item = Record<string, unknown>;

const INTERNAL_KEYS = new Set(['PK', 'SK', 'ttl']);

function strip<T>(item: Item): T {
  return Object.fromEntries(Object.entries(item).filter(([k]) => !INTERNAL_KEYS.has(k))) as T;
}

export class WorkflowsRepository {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string | undefined
  ) {}

  isConfigured(): boolean {
    return !!this.tableName;
  }

  /** Header and all pending step items in one transaction (≤ 11 items). */
  async create(record: WorkflowRecord, steps: WorkflowStepState[]): Promise<void> {
    const pk = workflowKeys.pk(record.userId);
    const ttl = workflowTtl();
    await this.client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: marshall(
                { PK: pk, SK: workflowKeys.header(record.workflowId), ...record, ttl },
                { removeUndefinedValues: true }
              ),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...steps.map((step) => ({
            Put: {
              TableName: this.tableName,
              Item: marshall(
                { PK: pk, SK: workflowKeys.step(record.workflowId, step.stepId), ...step, ttl },
                { removeUndefinedValues: true }
              ),
            },
          })),
        ],
      })
    );
  }

  async get(userId: UserId, workflowId: string): Promise<WorkflowRecord | null> {
    const res = await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK: workflowKeys.pk(userId), SK: workflowKeys.header(workflowId) }),
      })
    );
    return res.Item ? strip<WorkflowRecord>(unmarshall(res.Item)) : null;
  }

  async listSteps(userId: UserId, workflowId: string): Promise<WorkflowStepState[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: marshall({
          ':pk': workflowKeys.pk(userId),
          ':sk': workflowKeys.stepPrefix(workflowId),
        }),
      })
    );
    return (res.Items ?? []).map((i) => strip<WorkflowStepState>(unmarshall(i)));
  }

  /** Newest first — workflow ids are UUIDv7, so SK order is creation order. */
  async list(
    userId: UserId,
    limit: number,
    options: { consistentRead?: boolean } = {}
  ): Promise<WorkflowRecord[]> {
    const res = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: marshall({
          ':pk': workflowKeys.pk(userId),
          ':sk': workflowKeys.headerPrefix,
        }),
        ScanIndexForward: false,
        Limit: limit,
        ConsistentRead: options.consistentRead,
      })
    );
    return (res.Items ?? []).map((i) => strip<WorkflowRecord>(unmarshall(i)));
  }

  async markFailed(userId: UserId, workflowId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK: workflowKeys.pk(userId), SK: workflowKeys.header(workflowId) }),
        UpdateExpression: 'SET #s = :s, #e = :e, updatedAt = :now, completedAt = :now',
        ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
        ExpressionAttributeValues: marshall({ ':s': 'failed', ':e': error, ':now': now }),
      })
    );
  }

  async requestCancel(userId: UserId, workflowId: string): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({ PK: workflowKeys.pk(userId), SK: workflowKeys.header(workflowId) }),
        UpdateExpression: 'SET cancelRequested = :t, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: marshall({ ':t': true, ':now': new Date().toISOString() }),
      })
    );
  }
}
