import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../config/index', () => ({ config: { AWS_REGION: 'ap-northeast-1' } }));

import type { UserId, TokenLimitsConfig } from '@moca/core';
import type {
  MonthlyModelUsage,
  UsageDelta,
  UsageRepository,
} from '../../repositories/usage/index.js';
import { UsageService, parseTokenLimitsConfig } from '../usage-service';

const SONNET = 'global.anthropic.claude-sonnet-4-6';
const USER = '97745a78-00b1-70ed-13a3-1032026f75b4' as UserId;

function fakeRepo(rows: MonthlyModelUsage[] = []) {
  const added: { month: string; key: string; delta: UsageDelta }[] = [];
  const seen = new Set<string>();
  const repo: UsageRepository = {
    isConfigured: () => true,
    addBatch: async (_u, month, batchId, deltas) => {
      if (seen.has(batchId)) return 'duplicate';
      seen.add(batchId);
      for (const [key, delta] of deltas) added.push({ month, key, delta });
      return 'applied';
    },
    getMonth: async () => rows,
  };
  return { repo, added };
}

const config: TokenLimitsConfig = {
  timezone: 'Asia/Tokyo',
  allowedModelKeys: ['global.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-opus-5-5'],
  limits: {
    default: { input: 1000, output: 100 },
    'global.anthropic.claude-opus-5-5': { input: 100, output: 10 },
  },
  groups: { admin: 'unlimited' },
};

const row = (modelKey: string, inputTokens: number, outputTokens: number): MonthlyModelUsage => ({
  modelKey,
  inputTokens,
  outputTokens,
  uncachedInputTokens: inputTokens,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  calls: 1,
});

describe('UsageService.getSummary', () => {
  it('reports usage against the resolved limit with a status', async () => {
    const { repo } = fakeRepo([row('anthropic.claude-sonnet-4-6', 850, 10)]);
    const s = await new UsageService(config, repo).getSummary(
      USER,
      [],
      new Date('2026-11-22T00:00:00Z')
    );
    expect(s.enabled).toBe(true);
    expect(s.period).toEqual({
      month: '2026-11',
      timezone: 'Asia/Tokyo',
      resetsAt: '2026-11-30T15:00:00.000Z',
    });
    const sonnet = s.models.find((m) => m.modelKey === 'anthropic.claude-sonnet-4-6')!;
    expect(sonnet).toMatchObject({ input: { used: 850, limit: 1000 }, status: 'warning' });
    // Configured but unused models are listed so the UI can show their limit.
    expect(s.models.find((m) => m.modelKey === 'anthropic.claude-opus-5-5')).toMatchObject({
      input: { used: 0, limit: 100 },
      status: 'ok',
    });
  });

  it('applies group overrides and reports the effective groups', async () => {
    const { repo } = fakeRepo([row('anthropic.claude-opus-5-5', 500, 50)]);
    const s = await new UsageService(config, repo).getSummary(USER, ['admin', 'other-group']);
    expect(s.groups).toEqual(['admin']);
    expect(s.models[0]).toMatchObject({ input: { limit: null }, status: 'ok' });
  });

  it('is disabled without config', async () => {
    const { repo } = fakeRepo();
    const s = await new UsageService(null, repo).getSummary(USER, []);
    expect(s).toMatchObject({ enabled: false, models: [] });
  });
});

describe('UsageService.getSummary — default-only limits', () => {
  // Regression: a model limited only by `default` and unused this month was
  // missing from the summary, so the Runtime treated it as unlimited.
  it('lists every allowed model that resolves to a finite limit', async () => {
    const cfg: TokenLimitsConfig = {
      timezone: 'Asia/Tokyo',
      allowedModelKeys: ['global.anthropic.claude-haiku-5-5', 'jp.amazon.nova-2-lite-v1:0'],
      groups: { 'limit-test': { default: { input: 300, output: 3 } } },
    };
    const { repo } = fakeRepo();
    const s = await new UsageService(cfg, repo).getSummary(USER, ['limit-test']);
    expect(s.models.map((m) => m.modelKey).sort()).toEqual([
      'amazon.nova-2-lite-v1:0',
      'anthropic.claude-haiku-5-5',
    ]);
    expect(s.models[0]).toMatchObject({ input: { used: 0, limit: 300 }, output: { limit: 3 } });
  });

  it('omits allowed models that are unlimited for the user', async () => {
    const cfg: TokenLimitsConfig = {
      timezone: 'Asia/Tokyo',
      allowedModelKeys: ['global.anthropic.claude-haiku-5-5'],
      groups: { 'limit-test': { default: { input: 300, output: 3 } } },
    };
    const { repo } = fakeRepo();
    expect((await new UsageService(cfg, repo).getSummary(USER, [])).models).toEqual([]);
  });
});

describe('UsageService.record', () => {
  const rec = (modelId: string, out = 5) => ({
    modelId,
    uncachedInputTokens: 10,
    cacheReadInputTokens: 20,
    cacheWriteInputTokens: 30,
    outputTokens: out,
  });

  it('aggregates per model, using the server clock for the month', async () => {
    const { repo, added } = fakeRepo();
    // 15:30Z on 11/30 is already December in Tokyo.
    await new UsageService(config, repo).record(
      USER,
      'b1',
      [rec('jp.anthropic.claude-sonnet-4-6'), rec('global.anthropic.claude-sonnet-4-6', 7)],
      new Date('2026-11-30T15:30:00Z')
    );
    expect(added).toEqual([
      {
        month: '2026-12',
        key: 'anthropic.claude-sonnet-4-6',
        delta: {
          uncachedInputTokens: 20,
          cacheReadInputTokens: 40,
          cacheWriteInputTokens: 60,
          outputTokens: 12,
          calls: 2,
        },
      },
    ]);
  });

  it('folds models outside the allow-list into one "other" row', async () => {
    const { repo, added } = fakeRepo();
    await new UsageService(config, repo).record(USER, 'b1', [
      rec('evil.model-1'),
      rec('evil.model-2'),
    ]);
    expect(added.map((a) => a.key)).toEqual(['other']);
  });

  it('passes the batch id through so a retried batch is applied once', async () => {
    const { repo, added } = fakeRepo();
    const service = new UsageService(config, repo);
    expect(await service.record(USER, 'batch-x', [rec(SONNET)])).toBe('applied');
    expect(await service.record(USER, 'batch-x', [rec(SONNET)])).toBe('duplicate');
    expect(added).toHaveLength(1);
  });

  it('does nothing when disabled', async () => {
    const { repo, added } = fakeRepo();
    await new UsageService(null, repo).record(USER, 'b1', [
      rec('global.anthropic.claude-sonnet-4-6'),
    ]);
    expect(added).toEqual([]);
  });
});

describe('parseTokenLimitsConfig', () => {
  it('defaults the time zone and rejects invalid JSON', () => {
    const parsed = parseTokenLimitsConfig('{}', ['global.anthropic.claude-sonnet-4-6']);
    expect(parsed?.timezone).toBe('Asia/Tokyo');
    // image_to_text models are always meterable.
    expect(parsed?.allowedModelKeys).toEqual(
      expect.arrayContaining([
        'global.anthropic.claude-sonnet-4-6',
        'global.amazon.nova-2-lite-v1:0',
      ])
    );
    expect(parseTokenLimitsConfig('not json')).toBeNull();
    expect(parseTokenLimitsConfig(undefined)).toBeNull();
  });
});
