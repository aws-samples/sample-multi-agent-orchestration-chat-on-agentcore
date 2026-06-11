/**
 * settingsStore — per-model reasoning depth.
 *
 * The depth is keyed by modelId so switching models restores that model's
 * last-selected depth; unknown models default to 'off'.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../settingsStore';

describe('settingsStore reasoning depth', () => {
  beforeEach(() => {
    useSettingsStore.setState({ reasoningDepthByModel: {} });
  });

  it('defaults to off for a model with no stored depth', () => {
    expect(useSettingsStore.getState().getReasoningDepthFor('global.anthropic.claude-opus-4-8')).toBe(
      'off'
    );
  });

  it('stores and reads back a depth per model id', () => {
    const { setReasoningDepthFor, getReasoningDepthFor } = useSettingsStore.getState();
    setReasoningDepthFor('global.anthropic.claude-opus-4-8', 'high');
    setReasoningDepthFor('global.anthropic.claude-sonnet-4-6', 'low');

    expect(getReasoningDepthFor('global.anthropic.claude-opus-4-8')).toBe('high');
    expect(getReasoningDepthFor('global.anthropic.claude-sonnet-4-6')).toBe('low');
  });

  it('keeps each model independent (switching back restores prior depth)', () => {
    const { setReasoningDepthFor, getReasoningDepthFor } = useSettingsStore.getState();
    setReasoningDepthFor('modelA', 'max');
    setReasoningDepthFor('modelB', 'off');
    setReasoningDepthFor('modelA', 'low');

    expect(getReasoningDepthFor('modelA')).toBe('low');
    expect(getReasoningDepthFor('modelB')).toBe('off');
  });
});
