/**
 * CronFieldSelector Component
 *
 * Individual field selectors for custom cron expressions
 */

import { useTranslation } from 'react-i18next';
import { DAY_OF_WEEK_OPTIONS, MONTH_OPTIONS, type CronFields } from './cronUtils';

export interface CronFieldSelectorProps {
  /**
   * Current field values
   */
  fields: CronFields;

  /**
   * Callback when a field changes
   */
  onChange: (field: string, value: string) => void;

  /**
   * Whether selectors are disabled
   */
  disabled?: boolean;
}

export function CronFieldSelector({ fields, onChange, disabled = false }: CronFieldSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 bg-surface-secondary rounded-lg">
      {/* Minute */}
      <div>
        <label className="block text-xs font-medium text-fg-secondary mb-1">
          {t('triggers.cron.minute')} {t('triggers.cron.minuteRange')}
        </label>
        <input
          type="text"
          value={fields.minute}
          onChange={(e) => onChange('minute', e.target.value)}
          disabled={disabled}
          placeholder="0, *, 0-30"
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        />
      </div>

      {/* Hour */}
      <div>
        <label className="block text-xs font-medium text-fg-secondary mb-1">
          {t('triggers.cron.hour')} {t('triggers.cron.hourRange')}
        </label>
        <input
          type="text"
          value={fields.hour}
          onChange={(e) => onChange('hour', e.target.value)}
          disabled={disabled}
          placeholder="0, *, 9-17"
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        />
      </div>

      {/* Day of Month */}
      <div>
        <label className="block text-xs font-medium text-fg-secondary mb-1">
          {t('triggers.cron.dayOfMonth')} {t('triggers.cron.dayOfMonthRange')}
        </label>
        <input
          type="text"
          value={fields.dayOfMonth}
          onChange={(e) => onChange('dayOfMonth', e.target.value)}
          disabled={disabled}
          placeholder="1, *, ?, 1-15"
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        />
        <p className="mt-1 text-xs text-fg-muted">{t('triggers.cron.dayOfMonthHint')}</p>
      </div>

      {/* Month */}
      <div>
        <label className="block text-xs font-medium text-fg-secondary mb-1">
          {t('triggers.cron.month')}
        </label>
        <select
          value={fields.month}
          onChange={(e) => onChange('month', e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        >
          <option value="*">{t('triggers.cron.optionAll')}</option>
          {MONTH_OPTIONS.map((month) => (
            <option key={month.value} value={month.value}>
              {month.label}
            </option>
          ))}
        </select>
      </div>

      {/* Day of Week */}
      <div>
        <label className="block text-xs font-medium text-fg-secondary mb-1">
          {t('triggers.cron.dayOfWeek')}
        </label>
        <select
          value={fields.dayOfWeek}
          onChange={(e) => onChange('dayOfWeek', e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        >
          <option value="?">{t('triggers.cron.optionNotSpecified')}</option>
          <option value="*">{t('triggers.cron.optionAll')}</option>
          <option value="MON-FRI">{t('triggers.cron.optionWeekdays')}</option>
          {DAY_OF_WEEK_OPTIONS.map((day) => (
            <option key={day.value} value={day.value}>
              {day.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-fg-muted">{t('triggers.cron.dayOfWeekHint')}</p>
      </div>

      {/* Year */}
      <div>
        <label className="block text-xs font-medium text-fg-secondary mb-1">
          {t('triggers.cron.year')}
        </label>
        <input
          type="text"
          value={fields.year}
          onChange={(e) => onChange('year', e.target.value)}
          disabled={disabled}
          placeholder="*, 2024"
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        />
        <p className="mt-1 text-xs text-fg-muted">{t('triggers.cron.yearHint')}</p>
      </div>

      {/* Help Text */}
      <div className="col-span-2 md:col-span-3 mt-2">
        <div className="text-xs text-fg-secondary bg-feedback-info-bg p-3 rounded-md">
          <p className="font-medium mb-1">{t('triggers.cron.hintsTitle')}</p>
          <ul className="space-y-1 ml-4 list-disc">
            <li>{t('triggers.cron.hintAll')}</li>
            <li>{t('triggers.cron.hintNotSpecified')}</li>
            <li>{t('triggers.cron.hintRange')}</li>
            <li>{t('triggers.cron.hintMultiple')}</li>
            <li>{t('triggers.cron.hintDayWeekExclusive')}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
