import { describe, expect, it } from 'vitest';
import {
  configuredModelKeys,
  exceededDimension,
  modelUsageKey,
  resolveModelLimit,
  usageMonth,
  usageMonthResetsAt,
  usageStatus,
  type TokenLimitsConfigInput,
} from '../token-usage.js';

describe('modelUsageKey', () => {
  it('drops the cross-region profile prefix so profiles share a limit', () => {
    expect(modelUsageKey('global.anthropic.claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6');
    expect(modelUsageKey('jp.anthropic.claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6');
    expect(modelUsageKey('openai.gpt-oss-120b-1:0')).toBe('openai.gpt-oss-120b-1:0');
  });
});

describe('usageMonth / usageMonthResetsAt', () => {
  it('uses the local month in the configured time zone', () => {
    // 2026-11-30 15:30Z is already 12/1 00:30 in Tokyo.
    expect(usageMonth(new Date('2026-11-30T15:30:00Z'), 'Asia/Tokyo')).toBe('2026-12');
    expect(usageMonth(new Date('2026-11-30T14:59:59Z'), 'Asia/Tokyo')).toBe('2026-11');
    expect(usageMonth(new Date('2026-11-30T15:30:00Z'), 'UTC')).toBe('2026-11');
  });

  it('reports when the next month starts', () => {
    expect(usageMonthResetsAt('2026-11', 'Asia/Tokyo')).toBe('2026-11-30T15:00:00.000Z');
    expect(usageMonthResetsAt('2026-12', 'Asia/Tokyo')).toBe('2026-12-31T15:00:00.000Z');
    expect(usageMonthResetsAt('2026-02', 'America/New_York')).toBe('2026-03-01T05:00:00.000Z');
    expect(usageMonthResetsAt('2026-03', 'America/New_York')).toBe('2026-04-01T04:00:00.000Z');
  });
});

describe('resolveModelLimit', () => {
  const config: TokenLimitsConfigInput = {
    limits: {
      default: { input: 100, output: 10 },
      'global.anthropic.claude-opus-5-5': { input: 30, output: 5 },
      'global.amazon.nova-2-lite-v1:0': 'unlimited',
    },
    groups: {
      admin: 'unlimited',
      power: { default: { input: 300, output: 30 } },
      strict: { default: { input: 1, output: 1 } },
    },
  };
  const opus = 'anthropic.claude-opus-5-5';

  it('applies the model entry, then default, for users in no group', () => {
    expect(resolveModelLimit(config, [], opus)).toEqual({ input: 30, output: 5, groups: [] });
    expect(resolveModelLimit(config, [], 'anthropic.claude-haiku-5-5')).toMatchObject({
      input: 100,
    });
    expect(resolveModelLimit(config, ['unrelated'], 'amazon.nova-2-lite-v1:0')).toMatchObject({
      input: null,
      output: null,
    });
  });

  it('lets a configured group replace the base limits, even when stricter', () => {
    expect(resolveModelLimit(config, ['strict'], opus)).toEqual({
      input: 1,
      output: 1,
      groups: ['strict'],
    });
    expect(resolveModelLimit(config, ['power'], opus)).toMatchObject({ input: 300, output: 30 });
  });

  it('takes the loosest value per dimension across groups; unlimited wins', () => {
    expect(resolveModelLimit(config, ['strict', 'power'], opus)).toMatchObject({
      input: 300,
      output: 30,
    });
    expect(resolveModelLimit(config, ['power', 'admin'], opus)).toMatchObject({
      input: null,
      output: null,
    });
  });

  it('is unlimited when nothing is configured', () => {
    expect(resolveModelLimit({}, [], opus)).toEqual({ input: null, output: null, groups: [] });
  });

  it('lists configured model keys', () => {
    expect(configuredModelKeys(config, ['power']).sort()).toEqual([
      'amazon.nova-2-lite-v1:0',
      opus,
    ]);
  });
});

describe('usageStatus / exceededDimension', () => {
  it('warns at 80% and blocks at 100% of either dimension', () => {
    const d = (used: number, limit: number | null) => ({ used, limit });
    expect(usageStatus(d(79, 100), d(0, 10))).toBe('ok');
    expect(usageStatus(d(80, 100), d(0, 10))).toBe('warning');
    expect(usageStatus(d(0, 100), d(10, 10))).toBe('exceeded');
    expect(usageStatus(d(10 ** 9, null), d(10 ** 9, null))).toBe('ok');
    expect(exceededDimension({ input: d(5, 100), output: d(10, 10) })).toBe('output');
    expect(exceededDimension({ input: d(5, null), output: d(5, 10) })).toBeUndefined();
  });
});
