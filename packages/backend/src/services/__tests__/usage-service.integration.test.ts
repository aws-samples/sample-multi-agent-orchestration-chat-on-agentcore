/**
 * UsageService against DynamoDB Local: the full record → summary loop with
 * the real repository, including concurrent reporters, the month boundary,
 * default-only limits, group overrides and the `other` bucket.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../config/index', () => ({ config: { AWS_REGION: 'ap-northeast-1' } }));

import { randomUUID } from 'node:crypto';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { UserId } from '@moca/core';
import { DynamoDBUsageRepository } from '../../repositories/usage/dynamodb/repository.js';
import { makeLocalClient } from '../../tests/integration/client.js';
import { createUsageTable, deleteTable, uniqueTableName } from '../../tests/integration/tables.js';
import { UsageService, parseTokenLimitsConfig } from '../usage-service.js';

const USER = '11111111-2222-4333-8444-555555555555' as UserId;
const HAIKU = 'global.anthropic.claude-haiku-5-5';
const OPUS = 'global.anthropic.claude-opus-5-5';

let client: DynamoDBClient;
let tableName: string;
let service: UsageService;

const rec = (modelId: string, input: number, output: number) => ({
  modelId,
  uncachedInputTokens: input,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: output,
});

beforeAll(async () => {
  client = makeLocalClient();
  tableName = uniqueTableName('usage-svc');
  await createUsageTable(client, tableName);
  const cfg = parseTokenLimitsConfig(
    JSON.stringify({
      limits: { default: { input: 1000, output: 100 }, [OPUS]: { input: 50, output: 5 } },
      groups: { power: { default: { input: 10_000, output: 1_000 } }, admin: 'unlimited' },
    }),
    [HAIKU, OPUS]
  );
  service = new UsageService(cfg, new DynamoDBUsageRepository(client, tableName));
});

afterAll(async () => {
  await deleteTable(client, tableName);
  client.destroy();
});

const NOV = new Date('2026-11-15T00:00:00Z');
const model = async (groups: string[], key: string, now = NOV) =>
  (await service.getSummary(USER, groups, now)).models.find((m) => m.modelKey === key);

describe('UsageService (DynamoDB Local)', () => {
  it('lists limited models before any usage exists', async () => {
    expect(await model([], 'anthropic.claude-haiku-5-5')).toMatchObject({
      input: { used: 0, limit: 1000 },
      status: 'ok',
    });
  });

  it('accumulates concurrent reports exactly and flips status at 80% / 100%', async () => {
    await Promise.all(
      Array.from({ length: 16 }, () => service.record(USER, randomUUID(), [rec(HAIKU, 50, 5)], NOV))
    );
    expect(await model([], 'anthropic.claude-haiku-5-5')).toMatchObject({
      input: { used: 800 },
      output: { used: 80 },
      status: 'warning',
    });
    await service.record(
      USER,
      randomUUID(),
      [rec(`jp.${HAIKU.slice('global.'.length)}`, 200, 0)],
      NOV
    );
    expect(await model([], 'anthropic.claude-haiku-5-5')).toMatchObject({
      input: { used: 1000 },
      status: 'exceeded',
    });
  });

  it('applies group overrides to the same usage', async () => {
    expect(await model(['power'], 'anthropic.claude-haiku-5-5')).toMatchObject({ status: 'ok' });
    expect(await model(['admin'], 'anthropic.claude-haiku-5-5')).toMatchObject({
      input: { limit: null },
      status: 'ok',
    });
  });

  it('starts a new month at the JST boundary', async () => {
    const dec = new Date('2026-11-30T15:00:00Z'); // 12/1 00:00 JST
    await service.record(USER, randomUUID(), [rec(HAIKU, 1, 1)], dec);
    const s = await service.getSummary(USER, [], dec);
    expect(s.period.month).toBe('2026-12');
    expect(s.models.find((m) => m.modelKey === 'anthropic.claude-haiku-5-5')).toMatchObject({
      input: { used: 1 },
      status: 'ok',
    });
  });

  it('does not double count a retried batch', async () => {
    const batchId = randomUUID();
    const before = (await model([], 'anthropic.claude-opus-5-5'))!.output.used;
    expect(await service.record(USER, batchId, [rec(OPUS, 1, 3)], NOV)).toBe('applied');
    expect(await service.record(USER, batchId, [rec(OPUS, 1, 3)], NOV)).toBe('duplicate');
    expect((await model([], 'anthropic.claude-opus-5-5'))!.output.used).toBe(before + 3);
  });

  it('meters unknown models into one "other" row', async () => {
    await service.record(
      USER,
      randomUUID(),
      [rec('attacker.model-a', 1, 1), rec('attacker.model-b', 1, 1)],
      NOV
    );
    const rows = await new DynamoDBUsageRepository(client, tableName).getMonth(USER, '2026-11');
    expect(rows.filter((r) => r.modelKey === 'other')).toHaveLength(1);
    expect(rows.some((r) => r.modelKey.startsWith('attacker'))).toBe(false);
  });
});
