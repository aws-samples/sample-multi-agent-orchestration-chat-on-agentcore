import { describe, expect, it } from 'vitest';
import type { ModelUsage, UsageSummary } from '@moca/core';
import {
  formatResetAt,
  formatTokenCount,
  formatUsageMonth,
  modelNameForUsageKey,
  modelUsageIndicator,
  pickRetryModel,
  sortUsageRows,
  timeZoneAbbreviation,
  usageLevel,
  usagePercent,
} from '../usageFormat';

const usage = (
  modelKey: string,
  status: ModelUsage['status'],
  input = { used: 0, limit: 100 as number | null },
  output = { used: 0, limit: 100 as number | null }
): ModelUsage => ({ modelKey, status, input, output });

describe('formatTokenCount', () => {
  it.each([
    [82_100_000, '82.1M'],
    [100_000_000, '100M'],
    [500_000, '500K'],
    [820_000, '820K'],
    [3_400_000, '3.4M'],
    [12_000_000, '12M'],
    [2_500_000_000, '2.5B'],
    [950, '950'],
  ])('%d → %s', (value, text) => expect(formatTokenCount(value)).toBe(text));
});

describe('usage thresholds', () => {
  it('reports levels at 80% and 100%', () => {
    expect(usageLevel(79, 100)).toBe('normal');
    expect(usageLevel(80, 100)).toBe('warning');
    expect(usageLevel(100, 100)).toBe('exceeded');
    expect(usageLevel(0, 0)).toBe('exceeded');
  });

  it('floors the percentage and treats a zero limit as full', () => {
    expect(usagePercent(821, 1000)).toBe(82);
    expect(usagePercent(5, 0)).toBe(100);
  });
});

describe('period formatting', () => {
  it('formats the reset instant in the limit time zone', () => {
    expect(formatResetAt('2026-11-30T15:00:00Z', 'Asia/Tokyo')).toBe('12/1 00:00');
    expect(formatResetAt('not-a-date', 'Asia/Tokyo')).toBe('not-a-date');
  });

  it('abbreviates Asia/Tokyo as JST and falls back for unknown zones', () => {
    expect(timeZoneAbbreviation('Asia/Tokyo')).toBe('JST');
    expect(timeZoneAbbreviation('UTC')).toBe('UTC');
    expect(timeZoneAbbreviation('Not/AZone')).toBe('Not/AZone');
  });

  it('formats the month for the UI language', () => {
    expect(formatUsageMonth('2026-11', 'ja')).toBe('2026年11月');
    expect(formatUsageMonth('2026-11', 'en')).toBe('November 2026');
    expect(formatUsageMonth('bad', 'en')).toBe('bad');
  });
});

describe('model names', () => {
  it('maps a metering key back to the configured model, else returns the key', () => {
    expect(modelNameForUsageKey('anthropic.claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
    expect(modelNameForUsageKey('other')).toBe('other');
  });
});

describe('sortUsageRows', () => {
  it('orders exceeded, then warning, then the rest by name', () => {
    const rows = sortUsageRows([
      usage('anthropic.claude-haiku-5-5', 'ok'),
      usage('amazon.nova-2-lite-v1:0', 'ok'),
      usage('anthropic.claude-sonnet-4-6', 'warning'),
      usage('anthropic.claude-opus-5-5', 'exceeded'),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      'Claude Opus 5.5',
      'Claude Sonnet 4.6',
      'Claude Haiku 5.5',
      'Nova Lite 2',
    ]);
  });
});

describe('modelUsageIndicator', () => {
  const t = ((key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key) as never;
  const summary = (enabled: boolean, models: ModelUsage[]): UsageSummary => ({
    enabled,
    period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '2026-11-30T15:00:00Z' },
    groups: [],
    models,
  });

  it('is undefined when usage is unknown, disabled or the model has no row', () => {
    expect(modelUsageIndicator(null, 'global.anthropic.claude-opus-5-5', t)).toBeUndefined();
    expect(
      modelUsageIndicator(
        summary(false, [usage('anthropic.claude-opus-5-5', 'exceeded')]),
        'global.anthropic.claude-opus-5-5',
        t
      )
    ).toBeUndefined();
    expect(modelUsageIndicator(summary(true, []), 'global.x', t)).toBeUndefined();
  });

  it('describes which limit an exceeded model hit and when it resets', () => {
    const indicator = modelUsageIndicator(
      summary(true, [
        usage(
          'anthropic.claude-opus-5-5',
          'exceeded',
          { used: 1, limit: 30_000_000 },
          { used: 500_000, limit: 500_000 }
        ),
      ]),
      'jp.anthropic.claude-opus-5-5',
      t
    );
    expect(indicator?.status).toBe('exceeded');
    expect(indicator?.description).toContain('common.usageDimension.output');
    expect(indicator?.description).toContain('"limit":"500K"');
    expect(indicator?.description).toContain('"resetsAt":"12/1 00:00"');
  });

  it('passes warning through without a description', () => {
    expect(
      modelUsageIndicator(
        summary(true, [usage('anthropic.claude-sonnet-4-6', 'warning')]),
        'global.anthropic.claude-sonnet-4-6',
        t
      )
    ).toEqual({ status: 'warning' });
  });
});

describe('pickRetryModel', () => {
  const never = () => false;

  it('keeps the selected model when it is usable', () => {
    expect(
      pickRetryModel('anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-4-6', never)?.id
    ).toBe('global.anthropic.claude-sonnet-4-6');
  });

  it('skips the refused model and other exceeded models', () => {
    const model = pickRetryModel(
      'anthropic.claude-opus-5',
      'global.anthropic.claude-opus-5',
      (id) => id === 'global.anthropic.claude-opus-5-5'
    );
    expect(model?.id).toBe('global.anthropic.claude-opus-4-8');
  });

  it('returns undefined when every model is exceeded', () => {
    expect(pickRetryModel('x', 'y', () => true)).toBeUndefined();
  });
});
