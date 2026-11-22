/**
 * Settings "Usage" section: this month's input / output tokens and limits per
 * model. The only place the numbers are shown (the model selector only badges).
 */

import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import type { UsageStatus } from '@moca/core';
import { useUsageStore } from '../stores/usageStore';
import { Badge } from './ui/Badge';
import { UsageMeter } from './ui/UsageMeter';
import {
  formatResetAt,
  formatUsageMonth,
  sortUsageRows,
  timeZoneAbbreviation,
} from '../utils/usageFormat';

export const UsageSection: React.FC = () => {
  const { t, i18n } = useTranslation();
  const summary = useUsageStore((s) => s.summary);
  const isLoading = useUsageStore((s) => s.isLoading);
  const error = useUsageStore((s) => s.error);

  useEffect(() => {
    void useUsageStore.getState().fetchUsage();
  }, []);

  const rows = useMemo(() => sortUsageRows(summary?.models ?? []), [summary]);

  const body = () => {
    if (!summary) {
      if (error)
        return <p className="text-sm text-feedback-error">{t('settings.usage.loadError')}</p>;
      if (isLoading)
        return <div className="h-5 w-64 bg-surface-secondary rounded-sm animate-pulse" />;
      return null;
    }
    if (!summary.enabled) {
      return <p className="text-sm text-fg-secondary">{t('settings.usage.notConfigured')}</p>;
    }
    const { month, timezone, resetsAt } = summary.period;
    return (
      <>
        <p className="text-sm text-fg-secondary mb-4 flex flex-wrap items-center gap-x-1 gap-y-1">
          <span>
            {t('settings.usage.period', {
              month: formatUsageMonth(month, i18n.language),
              timezone: timeZoneAbbreviation(timezone),
              resetsAt: formatResetAt(resetsAt, timezone),
            })}
          </span>
          {summary.groups.length > 0 && (
            <>
              <span>{t('settings.usage.groups')}</span>
              {summary.groups.map((group) => (
                <span
                  key={group}
                  className="inline-flex px-2 py-0.5 text-xs rounded-full bg-surface-secondary border border-border text-fg-default"
                >
                  {group}
                </span>
              ))}
            </>
          )}
        </p>

        {rows.length === 0 ? (
          <p className="text-sm text-fg-secondary">{t('settings.usage.empty')}</p>
        ) : (
          <div className="border border-border rounded-card overflow-hidden">
            {/* Column headers: the stacked mobile layout labels each meter instead. */}
            <div
              aria-hidden="true"
              className="hidden md:grid md:grid-cols-[minmax(0,1fr)_32%_32%_7rem] gap-4 px-4 py-2 bg-surface-secondary text-xs font-medium text-fg-muted"
            >
              <span>{t('settings.usage.model')}</span>
              <span>{t('settings.usage.input')}</span>
              <span>{t('settings.usage.output')}</span>
              <span />
            </div>
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li
                  key={row.modelKey}
                  className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_32%_32%_7rem] gap-2 md:gap-4 px-4 py-3 text-sm md:items-center"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-fg-default truncate">{row.name}</span>
                    <span className="md:hidden">
                      <StatusBadge status={row.status} />
                    </span>
                  </div>
                  {(['input', 'output'] as const).map((dimension) => {
                    const label = t(
                      dimension === 'input' ? 'settings.usage.input' : 'settings.usage.output'
                    );
                    return (
                      <div key={dimension}>
                        <span className="md:hidden block text-xs text-fg-muted mb-0.5">
                          {label}
                        </span>
                        <UsageMeter
                          used={row[dimension].used}
                          limit={row[dimension].limit}
                          label={`${row.name} ${label}`}
                        />
                      </div>
                    );
                  })}
                  <div className="hidden md:flex justify-end">
                    <StatusBadge status={row.status} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-fg-muted mt-3">{t('settings.usage.footnote')}</p>
      </>
    );
  };

  return (
    <section className="mb-8" aria-labelledby="settings-usage-title">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="w-5 h-5 text-fg-secondary" aria-hidden="true" />
        <h2 id="settings-usage-title" className="text-lg font-semibold text-fg-default">
          {t('settings.usage.title')}
        </h2>
      </div>
      {body()}
    </section>
  );
};

const StatusBadge: React.FC<{ status: UsageStatus }> = ({ status }) => {
  const { t } = useTranslation();
  if (status === 'exceeded')
    return <Badge variant="danger">{t('common.usageBadge.exceeded')}</Badge>;
  if (status === 'warning')
    return <Badge variant="warning">{t('common.usageBadge.warning')}</Badge>;
  return null;
};
