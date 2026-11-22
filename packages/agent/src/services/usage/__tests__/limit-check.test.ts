import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UsageSummary } from '@moca/core';

const getSummary = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../usage-client.js', () => ({ getSummary }));
let pending = { input: 0, output: 0 };
jest.unstable_mockModule('../usage-recorder.js', () => ({
  acknowledgedSnapshot: () => ({ input: 0, output: 0 }),
  missingFromSummary: () => pending,
}));

const { checkTokenLimit } = await import('../limit-check.js');

const summary = (used: number): UsageSummary => ({
  enabled: true,
  period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '2026-11-30T15:00:00.000Z' },
  groups: [],
  models: [
    {
      modelKey: 'anthropic.claude-haiku-5-5',
      input: { used, limit: 100 },
      output: { used: 0, limit: 10 },
      status: used >= 100 ? 'exceeded' : 'ok',
    },
  ],
});
const ctx = { userId: 'u' } as never;

beforeEach(() => {
  pending = { input: 0, output: 0 };
});

describe('checkTokenLimit', () => {
  it('refuses with details when the model is over its limit (any profile prefix)', async () => {
    getSummary.mockResolvedValue({ kind: 'ok', value: summary(100) });
    expect(await checkTokenLimit(ctx, 'jp.anthropic.claude-haiku-5-5')).toEqual({
      modelKey: 'anthropic.claude-haiku-5-5',
      dimension: 'input',
      used: 100,
      limit: 100,
      resetsAt: '2026-11-30T15:00:00.000Z',
    });
  });

  it('includes usage this process has not reported yet', async () => {
    getSummary.mockResolvedValue({ kind: 'ok', value: summary(60) });
    pending = { input: 40, output: 0 };
    expect(await checkTokenLimit(ctx, 'global.anthropic.claude-haiku-5-5')).toMatchObject({
      used: 100,
    });
  });

  it.each([
    ['under the limit', { kind: 'ok', value: summary(10) }],
    ['the Backend is down', { kind: 'unavailable' }],
    ['the feature is off', { kind: 'ok', value: { ...summary(1000), enabled: false } }],
  ])('allows the turn when %s', async (_n, result) => {
    getSummary.mockResolvedValue(result);
    expect(await checkTokenLimit(ctx, 'global.anthropic.claude-haiku-5-5')).toBeUndefined();
  });

  it('allows models without a limit entry', async () => {
    getSummary.mockResolvedValue({ kind: 'ok', value: summary(1000) });
    expect(await checkTokenLimit(ctx, 'global.amazon.nova-2-lite-v1:0')).toBeUndefined();
  });
});
