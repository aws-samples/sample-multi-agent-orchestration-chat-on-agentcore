/**
 * ExecutionItem Component
 *
 * Display individual execution record with expandable event payload
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import type { ExecutionRecord } from '../../../types/trigger';

export interface ExecutionItemProps {
  execution: ExecutionRecord;
}

export function ExecutionItem({ execution }: ExecutionItemProps) {
  const { t, i18n } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  // Format date
  const formatDate = (dateStr: string): string => {
    const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US';
    return new Date(dateStr).toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => execution.eventPayload && setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface-secondary transition-colors"
      >
        <div className="text-left">
          <p className="text-sm text-fg-default">{formatDate(execution.executedAt)}</p>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-fg-muted font-mono">{execution.executionId}</span>
            {execution.sessionId && (
              <a
                href={`/chat/${execution.sessionId}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs text-action-primary hover:underline font-mono"
              >
                {execution.sessionId.slice(0, 12)}...
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
        {execution.eventPayload &&
          (isExpanded ? (
            <ChevronUp className="w-5 h-5 text-fg-disabled" />
          ) : (
            <ChevronDown className="w-5 h-5 text-fg-disabled" />
          ))}
      </button>

      {/* Event Payload (expandable) */}
      {isExpanded && execution.eventPayload && (
        <div className="px-4 pb-4 border-t bg-surface-primary">
          <p className="text-xs font-medium text-fg-secondary mb-2 pt-3">
            {t('triggers.history.eventPayload', 'Event Payload')}
          </p>
          <pre className="text-xs text-fg-default whitespace-pre-wrap font-mono bg-surface-secondary p-3 rounded-md max-h-64 overflow-auto">
            {execution.eventPayload}
          </pre>
        </div>
      )}
    </div>
  );
}
