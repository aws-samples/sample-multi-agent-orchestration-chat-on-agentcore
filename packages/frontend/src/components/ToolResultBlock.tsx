import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolResult } from '../types/index';

/**
 * Recursively walk a parsed JSON value and attempt to parse any string
 * values that look like JSON.  This handles the common pattern where
 * Lambda tools return `{ text: JSON.stringify({...}) }` — the inner
 * JSON string is expanded into a real object so it can be pretty-printed.
 */
function deepParseJsonStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    // Only attempt to parse strings that look like JSON objects or arrays
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const inner = JSON.parse(trimmed);
        // Recurse in case of nested stringified JSON
        return deepParseJsonStrings(inner);
      } catch {
        // Not valid JSON — return as-is
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepParseJsonStrings);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepParseJsonStrings(v);
    }
    return result;
  }

  return value;
}

interface ToolResultBlockProps {
  toolResult: ToolResult;
}

export const ToolResultBlock: React.FC<ToolResultBlockProps> = ({ toolResult }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Style based on error state (unified white background, change icon only)
  const getResultStyles = () => {
    if (toolResult.isError) {
      return {
        statusColor: 'text-feedback-error',
        label: t('tool.errorResult'),
        icon: (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"
            />
          </svg>
        ),
      };
    }
    return {
      statusColor: 'text-action-primary',
      label: t('tool.executionResult'),
      icon: (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    };
  };

  const resultStyles = getResultStyles();

  // Format result content
  // Recursively parse JSON string values so nested JSON (e.g. text blocks
  // containing serialised tool output) is displayed as structured objects.
  const formattedContent = (() => {
    try {
      const parsed = JSON.parse(toolResult.content);
      const expanded = deepParseJsonStrings(parsed);
      return {
        isJson: true,
        content: JSON.stringify(expanded, null, 2),
      };
    } catch {
      return {
        isJson: false,
        content: toolResult.content,
      };
    }
  })();

  return (
    <div className="tool-result-block w-full">
      {/* Main container with white background and gray border */}
      <div className="bg-surface-primary border border-border-strong rounded-lg text-sm hover:shadow-sm transition-shadow">
        {/* Header section (entire area is clickable) */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 px-3 py-1.5 w-full text-left hover:bg-surface-secondary transition-colors"
          aria-label={isExpanded ? '結果を隠す' : '結果を表示'}
        >
          {/* Icon and status */}
          <div className={`flex items-center ${resultStyles.statusColor}`}>{resultStyles.icon}</div>

          {/* Label (simplified) */}
          <span className="font-medium text-fg-default text-xs">{resultStyles.label}</span>

          {/* Expand button */}
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

        {/* Detailed content (integrated inside frame when expanded) */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-1 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-fg-muted text-xs font-medium">
                {formattedContent.isJson ? t('tool.jsonResponse') : t('tool.textResult')}
              </span>
              <button
                onClick={() => navigator.clipboard.writeText(toolResult.content)}
                className="text-fg-disabled hover:text-fg-secondary text-xs px-2 py-1 rounded hover:bg-surface-secondary transition-colors"
                title={t('common.copyToClipboard')}
              >
                {t('common.copy')}
              </button>
            </div>

            {/* Scrollable result display */}
            <div className="max-h-64 overflow-y-auto">
              <pre
                className={`
                  text-fg-default text-xs overflow-x-auto whitespace-pre-wrap break-words
                  bg-surface-secondary p-2 rounded border border-border
                  ${formattedContent.isJson ? 'font-mono' : 'font-sans'}
                `}
              >
                {formattedContent.content}
              </pre>
            </div>

            {/* Statistics */}
            {formattedContent.content.length > 500 && (
              <div className="mt-2 pt-2 border-t border-border">
                <p className="text-fg-disabled text-xs">
                  {t('common.charactersWithStatus', {
                    count: formattedContent.content.length,
                    status: toolResult.isError ? t('common.errorStatus') : t('common.success'),
                  })}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
