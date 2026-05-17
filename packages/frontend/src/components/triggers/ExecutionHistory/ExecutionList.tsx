/**
 * ExecutionList Component
 *
 * Table list of execution records (simplified: no status tracking)
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, ChevronDown, ChevronUp, ExternalLink, CheckCircle, XCircle } from 'lucide-react';
import { LoadingIndicator } from '../../ui/LoadingIndicator';
import type { ExecutionRecord } from '../../../types/trigger';

export interface ExecutionListProps {
  executions: ExecutionRecord[];
  isLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}

export function ExecutionList({ executions, isLoading, hasMore, onLoadMore }: ExecutionListProps) {
  const { t, i18n } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Format date with i18n locale (handles invalid/missing dates)
  const formatDate = (dateStr: string): string => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '-';
    const locale = i18n.language === 'ja' ? 'ja-JP' : 'en-US';
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const toggleExpand = (executionId: string) => {
    setExpandedId((prev) => (prev === executionId ? null : executionId));
  };

  if (isLoading && executions.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingIndicator />
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-fg-muted">{t('triggers.history.noHistory')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Executions Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-surface-secondary border-b border-border">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                {t('triggers.history.executedAt', 'Executed At')}
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                {t('triggers.history.sessionId', 'Session')}
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                {t('triggers.history.executionId')}
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider w-10">
                {/* expand toggle */}
              </th>
            </tr>
          </thead>
          <tbody className="bg-surface-primary divide-y divide-gray-200">
            {executions.map((execution) => {
              const isExpanded = expandedId === execution.executionId;

              return (
                <React.Fragment key={execution.executionId}>
                  <tr
                    className="hover:bg-surface-secondary transition-colors cursor-pointer"
                    onClick={() =>
                      (execution.eventPayload || execution.errorMessage) &&
                      toggleExpand(execution.executionId)
                    }
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {execution.errorMessage ? (
                          <XCircle className="w-4 h-4 text-feedback-error flex-shrink-0" />
                        ) : (
                          <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                        )}
                        <span className="text-sm text-fg-default">
                          {formatDate(execution.executedAt)}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {execution.sessionId ? (
                        <a
                          href={`/chat/${execution.sessionId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-action-primary hover:underline font-mono"
                        >
                          {execution.sessionId.slice(0, 12)}...
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-fg-muted">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs text-fg-muted font-mono truncate max-w-xs">
                        {execution.executionId}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      {(execution.eventPayload || execution.errorMessage) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(execution.executionId);
                          }}
                          className="text-fg-muted hover:text-fg-default"
                        >
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={4} className="px-6 py-4 bg-surface-secondary space-y-3">
                        {execution.errorMessage && (
                          <div>
                            <div className="text-xs font-medium text-feedback-error mb-1">
                              {t('triggers.history.error', 'Error')}
                            </div>
                            <pre className="text-xs text-feedback-error whitespace-pre-wrap font-mono bg-feedback-error-bg p-3 rounded-md border border-feedback-error-border max-h-32 overflow-auto">
                              {execution.errorMessage}
                            </pre>
                          </div>
                        )}
                        {execution.eventPayload && (
                          <div>
                            <div className="text-xs font-medium text-fg-muted mb-1">
                              {t('triggers.history.eventPayload', 'Event Payload')}
                            </div>
                            <pre className="text-xs text-fg-default whitespace-pre-wrap font-mono bg-surface-primary p-3 rounded-md border border-border max-h-64 overflow-auto">
                              {execution.eventPayload}
                            </pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Load More Button */}
      {hasMore && (
        <div className="flex justify-center pt-4">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoading}
            className="flex items-center gap-2 px-6 py-3 bg-surface-secondary0 text-white text-sm font-medium rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.loading')}
              </>
            ) : (
              <>
                {t('triggers.history.loadMore')}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
