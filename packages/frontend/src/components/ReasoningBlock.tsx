import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Reasoning } from '../types/index';

interface ReasoningBlockProps {
  reasoning: Reasoning;
  /** True while the assistant turn is still streaming (shows a "Thinking…" label). */
  isStreaming?: boolean;
}

/**
 * Collapsible reasoning (extended thinking) panel.
 *
 * Mirrors {@link ToolUseBlock}'s container/expander structure. Only the
 * human-readable reasoning text is rendered — the cryptographic signature and
 * encrypted redactedContent never reach the frontend, so there is nothing else
 * to show. Default collapsed to keep the chat focused on the answer.
 */
export const ReasoningBlock: React.FC<ReasoningBlockProps> = ({ reasoning, isStreaming }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="reasoning-block w-full">
      <div className="bg-surface-primary border border-border-strong rounded-lg text-sm hover:shadow-sm transition-shadow">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 px-3 py-1.5 w-full text-left hover:bg-surface-secondary transition-colors"
          aria-label={isExpanded ? t('common.reasoning') : t('common.reasoning')}
          aria-expanded={isExpanded}
        >
          {/* Lightbulb / thinking icon */}
          <div className="flex items-center text-fg-muted">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
              />
            </svg>
          </div>

          <span className="font-medium text-fg-default">{t('common.reasoning')}</span>

          {isStreaming && (
            <span className="text-xs text-action-primary animate-pulse">
              {t('common.thinking')}
            </span>
          )}

          <div className="text-fg-disabled ml-auto">
            <svg
              className={`w-3 h-3 transform transition-transform duration-200 ${
                isExpanded ? 'rotate-180' : ''
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </button>

        {isExpanded && (
          <div className="px-3 pb-3 pt-1 border-t border-border">
            <pre className="text-fg-secondary text-xs font-sans overflow-x-auto whitespace-pre-wrap break-words">
              {reasoning.text}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
