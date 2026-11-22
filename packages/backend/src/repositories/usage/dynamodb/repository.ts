/**
 * `DynamoDBUsageRepository` — DynamoDB-backed {@link UsageRepository}.
 * Config-free: client and table name are injected (see the factory).
 */

import {
  DynamoDBClient,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';
import type { UserId } from '@moca/core';
import type { UsageRepository } from '../usage-repository.js';
import type { MonthlyModelUsage, UsageDelta } from '../types.js';
import {
  BATCH_MARKER_TTL_SECONDS,
  batchMarkerKey,
  fromItemAttr,
  keyAttr,
  monthPrefix,
  ttlForMonth,
} from './item.js';

export class DynamoDBUsageRepository implements UsageRepository {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string | undefined
  ) {}

  isConfigured(): boolean {
    return !!this.tableName;
  }

  async addBatch(
    userId: UserId,
    month: string,
    batchId: string,
    deltas: ReadonlyMap<string, UsageDelta>
  ): Promise<'applied' | 'duplicate'> {
    const now = new Date();
    const updates: TransactWriteItem[] = [...deltas].map(([modelKey, delta]) => ({
      Update: {
        TableName: this.tableName,
        Key: keyAttr(userId, month, modelKey),
        UpdateExpression:
          'ADD inputTokens :in, outputTokens :out, uncachedInputTokens :un, cacheReadInputTokens :cr, cacheWriteInputTokens :cw, calls :calls SET updatedAt = :now, #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':in': {
            N: String(
              delta.uncachedInputTokens + delta.cacheReadInputTokens + delta.cacheWriteInputTokens
            ),
          },
          ':out': { N: String(delta.outputTokens) },
          ':un': { N: String(delta.uncachedInputTokens) },
          ':cr': { N: String(delta.cacheReadInputTokens) },
          ':cw': { N: String(delta.cacheWriteInputTokens) },
          ':calls': { N: String(delta.calls) },
          ':now': { S: now.toISOString() },
          ':ttl': { N: String(ttlForMonth(month)) },
        },
      },
    }));
    // The marker and the increments commit together: either the batch is
    // applied exactly once, or not at all (and a retry can apply it).
    const marker: TransactWriteItem = {
      Put: {
        TableName: this.tableName,
        Item: {
          ...batchMarkerKey(userId, batchId),
          ttl: { N: String(Math.floor(now.getTime() / 1000) + BATCH_MARKER_TTL_SECONDS) },
        },
        ConditionExpression: 'attribute_not_exists(sk)',
      },
    };
    try {
      await this.client.send(
        new TransactWriteItemsCommand({ TransactItems: [marker, ...updates] })
      );
      return 'applied';
    } catch (err) {
      const reasons = (err as TransactionCanceledException).CancellationReasons;
      if (
        err instanceof TransactionCanceledException &&
        reasons?.[0]?.Code === 'ConditionalCheckFailed'
      ) {
        return 'duplicate';
      }
      throw err;
    }
  }

  async getMonth(userId: UserId, month: string): Promise<MonthlyModelUsage[]> {
    const rows: MonthlyModelUsage[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
          ExpressionAttributeValues: { ':u': { S: userId }, ':p': { S: monthPrefix(month) } },
          ExclusiveStartKey: startKey,
        })
      );
      for (const item of result.Items ?? []) rows.push(fromItemAttr(item));
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return rows;
  }
}
