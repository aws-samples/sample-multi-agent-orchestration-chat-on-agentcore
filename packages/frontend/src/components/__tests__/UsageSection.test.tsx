// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { UsageSummary } from '@moca/core';
import { UsageSection } from '../UsageSection';
import { useUsageStore } from '../../stores/usageStore';
import { getMyUsage } from '../../api/usage';

vi.mock('../../api/usage', () => ({ getMyUsage: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}(${Object.values(vars).join('|')})` : key,
    i18n: { language: 'ja' },
  }),
}));

const SUMMARY: UsageSummary = {
  enabled: true,
  period: { month: '2026-11', timezone: 'Asia/Tokyo', resetsAt: '2026-11-30T15:00:00Z' },
  groups: ['power'],
  models: [
    {
      modelKey: 'amazon.nova-2-lite-v1:0',
      input: { used: 3_400_000, limit: null },
      output: { used: 50_000, limit: null },
      status: 'ok',
    },
    {
      modelKey: 'anthropic.claude-sonnet-4-6',
      input: { used: 82_100_000, limit: 100_000_000 },
      output: { used: 820_000, limit: 2_000_000 },
      status: 'warning',
    },
    {
      modelKey: 'anthropic.claude-opus-5-5',
      input: { used: 19_200_000, limit: 30_000_000 },
      output: { used: 500_000, limit: 500_000 },
      status: 'exceeded',
    },
  ],
};

beforeEach(() => {
  useUsageStore.getState().reset();
  vi.mocked(getMyUsage).mockReset();
});
afterEach(cleanup);

describe('UsageSection', () => {
  it('fetches on mount and lists models with the most urgent first', async () => {
    vi.mocked(getMyUsage).mockResolvedValue(SUMMARY);
    render(<UsageSection />);

    await screen.findByText('Claude Opus 5.5');
    expect(getMyUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'settings.usage.title' })).toBeInTheDocument();
    expect(
      screen.getByText('settings.usage.period(2026年11月|JST|12/1 00:00)')
    ).toBeInTheDocument();
    expect(screen.getByText('power')).toBeInTheDocument();

    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => within(li).getAllByText(/^(Claude|Nova)/)[0]!.textContent)).toEqual([
      'Claude Opus 5.5',
      'Claude Sonnet 4.6',
      'Nova Lite 2',
    ]);
    expect(within(items[0]!).getAllByText('common.usageBadge.exceeded').length).toBeGreaterThan(0);
    expect(within(items[1]!).getAllByText('common.usageBadge.warning').length).toBeGreaterThan(0);
    expect(within(items[2]!).queryByText(/common\.usageBadge/)).toBeNull();
    expect(
      screen.getByRole('meter', { name: 'Claude Opus 5.5 settings.usage.output' })
    ).toHaveAttribute('aria-valuenow', '500000');
    expect(within(items[2]!).queryByRole('meter')).toBeNull();
    expect(screen.getByText('settings.usage.footnote')).toBeInTheDocument();
  });

  it('omits the groups label when no group applies', async () => {
    vi.mocked(getMyUsage).mockResolvedValue({ ...SUMMARY, groups: [] });
    render(<UsageSection />);
    await screen.findByText('Claude Opus 5.5');
    expect(screen.queryByText('settings.usage.groups')).toBeNull();
  });

  it('says no limits are configured when the feature is off', async () => {
    vi.mocked(getMyUsage).mockResolvedValue({ ...SUMMARY, enabled: false });
    render(<UsageSection />);
    await screen.findByText('settings.usage.notConfigured');
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('reports a failed fetch', async () => {
    vi.mocked(getMyUsage).mockRejectedValue(new Error('503'));
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('settings.usage.loadError')).toBeInTheDocument());
  });

  it('says there is no usage yet when no model has a row', async () => {
    vi.mocked(getMyUsage).mockResolvedValue({ ...SUMMARY, models: [] });
    render(<UsageSection />);
    await screen.findByText('settings.usage.empty');
  });
});
