import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UsageMeter } from '../UsageMeter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => `${key}:${JSON.stringify(vars ?? {})}`,
  }),
}));

const render = (used: number, limit: number | null) =>
  renderToStaticMarkup(createElement(UsageMeter, { used, limit, label: 'Opus input' }));

describe('UsageMeter', () => {
  it('uses the link color below 80%', () => {
    const html = render(19_200_000, 30_000_000);
    expect(html).toContain('bg-fg-link');
    expect(html).toContain('19.2M / 30M');
    expect(html).toContain('64%');
  });

  it('switches to the warning color at 80%', () => {
    const html = render(80_000_000, 100_000_000);
    expect(html).toContain('bg-feedback-warning');
    expect(html).toContain('text-feedback-warning');
  });

  it('switches to the error color at 100% and caps the bar width', () => {
    const html = render(600_000, 500_000);
    expect(html).toContain('bg-feedback-error');
    expect(html).toContain('width:100%');
    expect(html).toContain('600K / 500K');
  });

  it('exposes meter semantics', () => {
    const html = render(82_100_000, 100_000_000);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="Opus input"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100000000"');
    expect(html).toContain('aria-valuenow="82100000"');
    expect(html).toContain('aria-valuetext="82.1M / 100M (82%)"');
  });

  it('shows only the used amount, without a bar, when unlimited', () => {
    const html = render(3_400_000, null);
    expect(html).not.toContain('role="meter"');
    expect(html).toContain('common.usageMeter.unlimited');
    expect(html).toContain('3.4M');
  });
});
