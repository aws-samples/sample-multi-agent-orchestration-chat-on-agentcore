/**
 * "Resend with <model>" on a pre-turn token-limit refusal.
 *
 * Clicking selects the model chosen by pickRetryModel and resends the prompt
 * (text only; image attachments are not kept). Renders nothing when every
 * other model is over its limit too.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../stores/chatStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUsageStore } from '../stores/usageStore';
import { shortModelName } from './ui/ModelReasoningSelector/helpers';
import { pickRetryModel } from '../utils/usageFormat';
import type { Message } from '../types/index';

interface TokenLimitRetryButtonProps {
  retry: NonNullable<Message['tokenLimitRetry']>;
}

export const TokenLimitRetryButton: React.FC<TokenLimitRetryButtonProps> = ({ retry }) => {
  const { t } = useTranslation();
  const selectedModelId = useSettingsStore((s) => s.selectedModelId);
  // Subscribe to the summary so the choice follows a refetch.
  useUsageStore((s) => s.summary);
  const isLoading = useChatStore((s) => s.sessions[retry.sessionId]?.isLoading ?? false);

  const model = pickRetryModel(
    retry.modelKey,
    selectedModelId,
    (id) => useUsageStore.getState().statusFor(id) === 'exceeded'
  );
  if (!model) return null;

  const resend = () => {
    useSettingsStore.getState().setSelectedModelId(model.id);
    void useChatStore.getState().sendPrompt(retry.prompt, retry.sessionId);
  };

  return (
    <div className="mt-3 flex gap-2">
      <button
        type="button"
        onClick={resend}
        disabled={isLoading}
        className="px-2.5 py-1 text-xs rounded-lg bg-surface-primary border border-border text-fg-default hover:bg-surface-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {t('chat.tokenLimitRetryWith', { model: shortModelName(model.name) })}
      </button>
    </div>
  );
};
