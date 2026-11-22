/**
 * UsageRepository against DynamoDB Local: atomic ADD from concurrent writers,
 * month isolation, and the TTL attribute.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { UserId } from '@moca/core';
import { DynamoDBUsageRepository } from './repository.js';
import { batchMarkerKey, keyAttr, ttlForMonth } from './item.js';
import { makeLocalClient } from '../../../tests/integration/client.js';
import {
  createUsageTable,
  deleteTable,
  uniqueTableName,
} from '../../../tests/integration/tables.js';

const USER = 'user-usage-a' as UserId;
const OTHER = 'user-usage-b' as UserId;
const MODEL = 'anthropic.claude-sonnet-4-6';
import { randomUUID } from 'node:crypto';
const one = (modelKey: string, d: typeof delta) => new Map([[modelKey, d]]);
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
      Array.from({ length: 20 }, () =>
        repo.addBatch(USER, '2026-11', randomUUID(), one(MODEL, delta))
      )
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
    await repo.addBatch(USER, '2026-12', randomUUID(), one(MODEL, delta));
    await repo.addBatch(OTHER, '2026-11', randomUUID(), one('openai.gpt-oss-120b-1:0', delta));
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

  it('applies a batch at most once, even under concurrent retries', async () => {
    const batchId = randomUUID();
    const deltas = new Map([
      ['dedupe.model-a', delta],
      ['dedupe.model-b', delta],
    ]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.addBatch(USER, '2027-01', batchId, deltas))
    );
    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4);
    const rows = await repo.getMonth(USER, '2027-01');
    expect(rows.map((r) => [r.modelKey, r.outputTokens]).sort()).toEqual([
      ['dedupe.model-a', 7],
      ['dedupe.model-b', 7],
    ]);
  });

  it('keeps batch markers out of the monthly rows and expires them', async () => {
    const batchId = randomUUID();
    await repo.addBatch(USER, '2027-02', batchId, one(MODEL, delta));
    expect((await repo.getMonth(USER, '2027-02')).map((r) => r.modelKey)).toEqual([MODEL]);
    const marker = await client.send(
      new GetItemCommand({ TableName: tableName, Key: batchMarkerKey(USER, batchId) })
    );
    const ttl = Number(marker.Item?.ttl?.N);
    expect(ttl).toBeGreaterThan(Date.now() / 1000);
    expect(ttl).toBeLessThan(Date.now() / 1000 + 2 * 86_400);
  });
});
