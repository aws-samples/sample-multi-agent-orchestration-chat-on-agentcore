// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TokenLimitRetryButton } from '../TokenLimitRetryButton';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUsageStore } from '../../stores/usageStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => `${key}(${vars?.model ?? ''})`,
  }),
}));

const SESSION_ID = 'abcdefghij0123456789ABCDEFGHIJ012';
const retry = { prompt: 'summarize', sessionId: SESSION_ID, modelKey: 'anthropic.claude-opus-5-5' };
let sendPrompt: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendPrompt = vi.fn().mockResolvedValue(undefined);
  useChatStore.setState({ sessions: {}, sendPrompt } as never);
  useSettingsStore.setState({ selectedModelId: 'global.anthropic.claude-opus-5-5' });
  useUsageStore.getState().reset();
});
afterEach(cleanup);

describe('TokenLimitRetryButton', () => {
  it('resends the prompt with the first usable model and selects it', () => {
    render(<TokenLimitRetryButton retry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.tokenLimitRetryWith(Opus 5)' }));
    expect(useSettingsStore.getState().selectedModelId).toBe('global.anthropic.claude-opus-5');
    expect(sendPrompt).toHaveBeenCalledWith('summarize', SESSION_ID);
  });

  it('is disabled while the session is busy', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: { messages: [], isLoading: true, error: null, lastUpdated: new Date() },
      },
    });
    render(<TokenLimitRetryButton retry={retry} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
