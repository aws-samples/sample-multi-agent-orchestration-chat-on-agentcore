import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModelReasoningSelector } from '../ModelReasoningSelector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ModelReasoningSelector restored trigger settings', () => {
  it.each(['global.', 'us.', 'eu.', 'au.', 'jp.'])(
    'renders an always-on badge for saved off with the %s profile',
    (prefix) => {
      const html = renderToStaticMarkup(
        createElement(ModelReasoningSelector, {
          modelId: `${prefix}anthropic.claude-opus-5-5`,
          reasoningEffort: 'off',
          onModelChange: vi.fn(),
        })
      );
      expect(html).toContain('common.reasoningDepthModelDefault');
      expect(html).not.toContain('common.reasoningDepthOff');
    }
  );

  it('shows the model-managed badge when effort is absent', () => {
    const html = renderToStaticMarkup(
      createElement(ModelReasoningSelector, {
        modelId: 'global.anthropic.claude-opus-5-5',
        onModelChange: vi.fn(),
      })
    );
    expect(html).toContain('common.reasoningDepthModelDefault');
  });

  it('does not add a badge to other models at off', () => {
    const html = renderToStaticMarkup(
      createElement(ModelReasoningSelector, {
        modelId: 'global.anthropic.claude-opus-5',
        reasoningEffort: 'off',
        onModelChange: vi.fn(),
      })
    );
    expect(html).not.toContain('common.reasoningDepth');
  });
});
