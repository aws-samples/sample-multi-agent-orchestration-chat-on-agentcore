import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UsageSummary } from '@moca/core';
import { useUsageStore, USAGE_REFRESH_DEBOUNCE_MS } from '../usageStore';
import { getMyUsage } from '../../api/usage';

vi.mock('../../api/usage', () => ({ getMyUsage: vi.fn() }));

const summary = (enabled = true): UsageSummary => ({
  enabled,
  period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '2026-11-30T15:00:00Z' },
  groups: ['power'],
  models: [
    {
      modelKey: 'anthropic.claude-sonnet-4-6',
      input: { used: 82, limit: 100 },
      output: { used: 1, limit: 100 },
      status: 'warning',
    },
    {
      modelKey: 'anthropic.claude-opus-5-5',
      input: { used: 1, limit: 100 },
      output: { used: 100, limit: 100 },
      status: 'exceeded',
    },
  ],
});

beforeEach(() => {
  useUsageStore.getState().reset();
  vi.mocked(getMyUsage).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usageStore', () => {
  it('maps model ids with any cross-region prefix to their metering key', async () => {
    vi.mocked(getMyUsage).mockResolvedValue(summary());
    await useUsageStore.getState().fetchUsage();

    const { statusFor, usageFor } = useUsageStore.getState();
    expect(statusFor('global.anthropic.claude-sonnet-4-6')).toBe('warning');
    expect(statusFor('jp.anthropic.claude-sonnet-4-6')).toBe('warning');
    expect(statusFor('anthropic.claude-opus-5-5')).toBe('exceeded');
    expect(statusFor('global.anthropic.claude-haiku-5-5')).toBeUndefined();
    expect(usageFor('us.anthropic.claude-opus-5-5')?.output.used).toBe(100);
  });

  it('reports nothing while limits are disabled', async () => {
    vi.mocked(getMyUsage).mockResolvedValue(summary(false));
    await useUsageStore.getState().fetchUsage();
    expect(useUsageStore.getState().statusFor('global.anthropic.claude-opus-5-5')).toBeUndefined();
  });

  it('drops the summary on failure so no stale badge is shown', async () => {
    vi.mocked(getMyUsage).mockResolvedValueOnce(summary());
    await useUsageStore.getState().fetchUsage();
    vi.mocked(getMyUsage).mockRejectedValueOnce(new Error('503'));
    await useUsageStore.getState().fetchUsage();

    const state = useUsageStore.getState();
    expect(state.summary).toBeNull();
    expect(state.error).toBe('503');
    expect(state.isLoading).toBe(false);
    expect(state.statusFor('global.anthropic.claude-opus-5-5')).toBeUndefined();
  });

  it('ignores a response that arrives after reset (sign-out)', async () => {
    let resolve!: (s: UsageSummary) => void;
    vi.mocked(getMyUsage).mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useUsageStore.getState().fetchUsage();
    useUsageStore.getState().reset();
    resolve(summary());
    await pending;
    expect(useUsageStore.getState().summary).toBeNull();
  });

  it('debounces refreshes after turn completion', async () => {
    vi.useFakeTimers();
    vi.mocked(getMyUsage).mockResolvedValue(summary());
    const { scheduleRefresh } = useUsageStore.getState();
    scheduleRefresh();
    vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS - 1);
    scheduleRefresh();
    vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS - 1);
    expect(getMyUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getMyUsage).toHaveBeenCalledTimes(1);
  });
});
