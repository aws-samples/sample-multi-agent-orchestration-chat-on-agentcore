/**
 * UsageRepository against DynamoDB Local: atomic ADD from concurrent writers,
 * month isolation, and the TTL attribute.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { UserId } from '@moca/core';
import { DynamoDBUsageRepository } from './repository.js';
import { keyAttr, ttlForMonth } from './item.js';
import { makeLocalClient } from '../../../tests/integration/client.js';
import {
  createUsageTable,
  deleteTable,
  uniqueTableName,
} from '../../../tests/integration/tables.js';

const USER = 'user-usage-a' as UserId;
const OTHER = 'user-usage-b' as UserId;
const MODEL = 'anthropic.claude-sonnet-4-6';
const delta = {
  uncachedInputTokens: 1,
  cacheReadInputTokens: 10,
  cacheWriteInputTokens: 100,
  outputTokens: 7,
  calls: 1,
};

let client: DynamoDBClient;
let tableName: string;
let repo: DynamoDBUsageRepository;

beforeAll(async () => {
  client = makeLocalClient();
  tableName = uniqueTableName('usage');
  await createUsageTable(client, tableName);
  repo = new DynamoDBUsageRepository(client, tableName);
});

afterAll(async () => {
  await deleteTable(client, tableName);
  client.destroy();
});

describe('DynamoDBUsageRepository', () => {
  it('adds concurrent deltas atomically', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => repo.addUsage(USER, '2026-11', MODEL, delta))
    );
    const [row] = await repo.getMonth(USER, '2026-11');
    expect(row).toEqual({
      modelKey: MODEL,
      inputTokens: 20 * 111,
      outputTokens: 20 * 7,
      uncachedInputTokens: 20,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 2000,
      calls: 20,
    });
  });

  it('keeps months and users apart', async () => {
    await repo.addUsage(USER, '2026-12', MODEL, delta);
    await repo.addUsage(OTHER, '2026-11', 'openai.gpt-oss-120b-1:0', delta);
    expect((await repo.getMonth(USER, '2026-12')).map((r) => r.outputTokens)).toEqual([7]);
    expect((await repo.getMonth(OTHER, '2026-11')).map((r) => r.modelKey)).toEqual([
      'openai.gpt-oss-120b-1:0',
    ]);
  });

  it('sets the TTL once from the month', async () => {
    const item = await client.send(
      new GetItemCommand({ TableName: tableName, Key: keyAttr(USER, '2026-11', MODEL) })
    );
    expect(Number(item.Item?.ttl?.N)).toBe(ttlForMonth('2026-11'));
  });
});
