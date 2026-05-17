/**
 * ScheduleConfig Component
 *
 * Schedule configuration using CronBuilder
 */

import { useTranslation } from 'react-i18next';
import { CronBuilder } from '../CronBuilder';

export interface ScheduleConfigProps {
  cronExpression: string;
  timezone: string;
  onCronChange: (expression: string) => void;
  onTimezoneChange: (timezone: string) => void;
  disabled?: boolean;
}

export function ScheduleConfig({
  cronExpression,
  timezone,
  onCronChange,
  onTimezoneChange,
  disabled = false,
}: ScheduleConfigProps) {
  const { t } = useTranslation();

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-fg-default">
          {t('triggers.form.scheduleConfig')}
        </h3>
        <p className="text-sm text-fg-muted mt-1">{t('triggers.form.scheduleConfigDescription')}</p>
      </div>

      <CronBuilder
        value={cronExpression}
        timezone={timezone}
        onChange={onCronChange}
        onTimezoneChange={onTimezoneChange}
        disabled={disabled}
      />
    </div>
  );
}
