/**
 * CronPreview Component
 *
 * Preview cron expression with human-readable description and next execution times
 */

import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { getCronDescription, getNextExecutions, formatExecutionTime } from './cronUtils';

export interface CronPreviewProps {
  /**
   * Cron expression to preview
   */
  expression: string;

  /**
   * Timezone for execution times
   */
  timezone: string;

  /**
   * Whether the expression is valid
   */
  isValid: boolean;
}

export function CronPreview({ expression, timezone, isValid }: CronPreviewProps) {
  const { t, i18n } = useTranslation();

  if (!isValid) {
    return (
      <div className="p-4 bg-feedback-error-bg border border-feedback-error-border rounded-lg">
        <p className="text-sm text-feedback-error">{t('triggers.cron.invalidExpression')}</p>
      </div>
    );
  }

  const description = getCronDescription(expression, t);
  const nextExecutions = getNextExecutions(expression, timezone, 3);

  return (
    <div className="space-y-4">
      {/* Human-readable description */}
      <div className="p-4 bg-feedback-info-bg border border-feedback-info-border rounded-lg">
        <p className="text-sm font-medium text-action-primary">{description}</p>
        <p className="text-xs text-action-primary mt-1 font-mono">{expression}</p>
      </div>

      {/* Next execution times */}
      {nextExecutions.length > 0 && (
        <div className="p-4 bg-surface-secondary border border-border rounded-lg">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-fg-secondary" />
            <p className="text-sm font-medium text-fg-secondary">
              {t('triggers.cron.nextExecutions')}
            </p>
          </div>
          <div className="space-y-2">
            {nextExecutions.map((date, index) => (
              <div key={index} className="flex items-center gap-2 text-sm text-fg-secondary pl-6">
                <span className="text-fg-disabled">{index + 1}.</span>
                <span className="font-mono">{formatExecutionTime(date, i18n.language)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
