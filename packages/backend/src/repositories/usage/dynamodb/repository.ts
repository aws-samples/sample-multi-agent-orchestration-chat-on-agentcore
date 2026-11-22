/**
 * `DynamoDBUsageRepository` — DynamoDB-backed {@link UsageRepository}.
 * Config-free: client and table name are injected (see the factory).
 */

import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { UserId } from '@moca/core';
import type { UsageRepository } from '../usage-repository.js';
import type { MonthlyModelUsage, UsageDelta } from '../types.js';
import { fromItemAttr, keyAttr, monthPrefix, ttlForMonth } from './item.js';

export class DynamoDBUsageRepository implements UsageRepository {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tableName: string | undefined
  ) {}

  isConfigured(): boolean {
    return !!this.tableName;
  }

  async addUsage(
    userId: UserId,
    month: string,
    modelKey: string,
    delta: UsageDelta
  ): Promise<void> {
    const input =
      delta.uncachedInputTokens + delta.cacheReadInputTokens + delta.cacheWriteInputTokens;
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: keyAttr(userId, month, modelKey),
        UpdateExpression:
          'ADD inputTokens :in, outputTokens :out, uncachedInputTokens :un, cacheReadInputTokens :cr, cacheWriteInputTokens :cw, calls :calls SET updatedAt = :now, #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':in': { N: String(input) },
          ':out': { N: String(delta.outputTokens) },
          ':un': { N: String(delta.uncachedInputTokens) },
          ':cr': { N: String(delta.cacheReadInputTokens) },
          ':cw': { N: String(delta.cacheWriteInputTokens) },
          ':calls': { N: String(delta.calls) },
          ':now': { S: new Date().toISOString() },
          ':ttl': { N: String(ttlForMonth(month)) },
        },
      })
    );
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
