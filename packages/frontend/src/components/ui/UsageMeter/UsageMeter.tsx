/**
 * UsageMeter Atom Component
 * Used / limit bar for a monthly token quota. A null limit means unlimited:
 * only the used amount is shown, without a bar.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import {
  formatTokenCount,
  usageLevel,
  usagePercent,
  type UsageLevel,
} from '../../../utils/usageFormat';

export interface UsageMeterProps {
  used: number;
  /** null = unlimited */
  limit: number | null;
  /** Accessible name of the meter (e.g. "Claude Opus 5.5 input"). */
  label?: string;
  className?: string;
}

const fillStyles: Record<UsageLevel, string> = {
  normal: 'bg-fg-link',
  warning: 'bg-feedback-warning',
  exceeded: 'bg-feedback-error',
};

const textStyles: Record<UsageLevel, string> = {
  normal: 'text-fg-secondary',
  warning: 'text-feedback-warning font-medium',
  exceeded: 'text-feedback-error font-medium',
};

export const UsageMeter: React.FC<UsageMeterProps> = ({ used, limit, label, className }) => {
  const { t } = useTranslation();

  if (limit === null) {
    return (
      <p className={cn('text-xs text-fg-muted', className)}>
        {t('common.usageMeter.unlimited', { used: formatTokenCount(used) })}
      </p>
    );
  }

  const level = usageLevel(used, limit);
  const percent = usagePercent(used, limit);
  const valueText = `${formatTokenCount(used)} / ${formatTokenCount(limit)}`;

  return (
    <div className={cn('w-full', className)}>
      <div className={cn('flex justify-between gap-2 text-xs mb-1', textStyles[level])}>
        <span>{valueText}</span>
        <span>{percent}%</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${valueText} (${percent}%)`}
        className="w-full h-1.5 rounded-full bg-border overflow-hidden"
      >
        <span
          className={cn('block h-full rounded-full', fillStyles[level])}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
};
