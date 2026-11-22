// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { ModelReasoningSelector } from '../ModelReasoningSelector';
import type { ModelUsageIndicator } from '../../../../utils/usageFormat';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const OPUS = 'global.anthropic.claude-opus-5-5';
const SONNET = 'global.anthropic.claude-sonnet-4-6';

function open(usage: Record<string, ModelUsageIndicator>, onModelChange = vi.fn()) {
  render(
    <MemoryRouter>
      <ModelReasoningSelector
        modelId={SONNET}
        onModelChange={onModelChange}
        usageFor={(id) => usage[id]}
        usageHref="/settings"
      />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: /Sonnet 4.6/ }));
  return onModelChange;
}

const row = (name: string) => screen.getByText(name).closest('button')!;

describe('ModelReasoningSelector usage badges', () => {
  it('shows no badge and no usage link when every model is ok', () => {
    open({ [OPUS]: { status: 'ok' } });
    expect(screen.queryByText('common.usageBadge.warning')).toBeNull();
    expect(screen.queryByText('common.usageBadge.exceeded')).toBeNull();
    expect(screen.queryByText('common.usageBadge.viewUsage')).toBeNull();
    expect(row('Claude Opus 5.5')).not.toHaveAttribute('aria-disabled');
  });

  it('badges a warning model, keeps it selectable and links to the usage page', () => {
    const onModelChange = open({ [OPUS]: { status: 'warning' } });
    expect(row('Claude Opus 5.5')).toHaveTextContent('common.usageBadge.warning');
    expect(screen.getByRole('link', { name: 'common.usageBadge.viewUsage' })).toHaveAttribute(
      'href',
      '/settings'
    );
    fireEvent.click(row('Claude Opus 5.5'));
    expect(onModelChange).toHaveBeenCalledWith(OPUS);
  });

  it('disables an exceeded model and describes why', () => {
    const onModelChange = open({
      [OPUS]: { status: 'exceeded', description: 'Output limit (500K) reached. Resets 12/1.' },
    });
    const opus = row('Claude Opus 5.5');
    expect(opus).toHaveTextContent('common.usageBadge.exceeded');
    expect(opus).toHaveAttribute('aria-disabled', 'true');
    expect(opus).toHaveAccessibleDescription('Output limit (500K) reached. Resets 12/1.');
    expect(screen.getByText('Claude Opus 5.5')).toHaveClass('text-fg-disabled');

    fireEvent.click(opus);
    expect(onModelChange).not.toHaveBeenCalled();
    // The menu stays open; other models remain selectable.
    fireEvent.click(row('Claude Haiku 5.5'));
    expect(onModelChange).toHaveBeenCalledWith('global.anthropic.claude-haiku-5-5');
  });

  it('keeps the trigger button unchanged', () => {
    open({ [SONNET]: { status: 'exceeded', description: 'd' } });
    const trigger = screen.getAllByRole('button')[0]!;
    expect(trigger).not.toHaveTextContent('common.usageBadge.exceeded');
  });
});
