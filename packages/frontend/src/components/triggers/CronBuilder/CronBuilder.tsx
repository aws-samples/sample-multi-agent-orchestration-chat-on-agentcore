/**
 * CronBuilder Component
 *
 * AWS EventBridge Scheduler Cron expression builder with presets and custom fields
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { CronPresetButtons } from './CronPresetButtons';
import { CronPreview } from './CronPreview';
import {
  validateCronExpression,
  validateScheduleInterval,
  CRON_PRESETS,
  TIMEZONES,
} from './cronUtils';

export interface CronBuilderProps {
  value: string;
  timezone: string;
  onChange: (expression: string) => void;
  onTimezoneChange: (timezone: string) => void;
  disabled?: boolean;
}

export function CronBuilder({
  value,
  timezone,
  onChange,
  onTimezoneChange,
  disabled = false,
}: CronBuilderProps) {
  const { t } = useTranslation();

  // Check if current value is a preset
  const isPreset = CRON_PRESETS.some((preset) => preset.expression === value);
  const [isCustom, setIsCustom] = useState(!isPreset);

  // Handle preset selection
  const handlePresetSelect = (presetExpression: string) => {
    setIsCustom(false);
    onChange(presetExpression);
  };

  // Handle custom mode toggle
  const handleCustomToggle = () => {
    setIsCustom(true);
  };

  // Handle custom expression input
  const handleCustomInput = (expression: string) => {
    onChange(expression);
  };

  const isValid = validateCronExpression(value);
  // Schedule interval classification. 'too-short' degrades the expression to
  // invalid (blocks submit); 'warning' surfaces a cost caution banner while
  // still allowing creation; 'unknown' (parse failure) conservatively shows
  // the warning banner so the user double-checks before confirming.
  const intervalClass = validateScheduleInterval(value);
  const intervalTooShort = intervalClass === 'too-short';
  const showCostWarning = intervalClass === 'warning' || intervalClass === 'unknown';

  return (
    <div className="space-y-6">
      {/* Timezone Selector */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.cron.timezone')}
        </label>
        <select
          value={timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 border border-border-strong rounded-lg bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </div>

      {/* Preset Buttons */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.cron.preset')}
        </label>
        <CronPresetButtons
          selectedExpression={value}
          onSelect={handlePresetSelect}
          onCustom={handleCustomToggle}
          isCustom={isCustom}
          disabled={disabled}
        />
      </div>

      {/* Custom Expression Input (shown when custom mode is active) */}
      <div
        className={`transition-all duration-200 ${
          isCustom ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden'
        }`}
      >
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.cron.customExpression')}
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => handleCustomInput(e.target.value)}
          disabled={disabled || !isCustom}
          placeholder="0 0 * * ? *"
          className="w-full px-3 py-2 border border-border-strong rounded-lg bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus disabled:bg-surface-secondary disabled:cursor-not-allowed font-mono text-sm"
        />
        <p className="mt-1 text-xs text-fg-muted">{t('triggers.cron.customExpressionHint')}</p>
      </div>

      {/* Preview */}
      <div>
        <label className="block text-sm font-medium text-fg-secondary mb-2">
          {t('triggers.cron.preview')}
        </label>
        <CronPreview
          expression={value}
          timezone={timezone}
          isValid={isValid && !intervalTooShort}
        />
      </div>

      {/* Validation Error */}
      {!isValid && (
        <div className="text-sm text-feedback-error">{t('triggers.cron.invalidExpression')}</div>
      )}

      {/* Minimum interval error (< 1 minute) — blocks submit */}
      {isValid && intervalTooShort && (
        <div
          role="alert"
          className="text-sm text-feedback-error border border-feedback-error-border bg-feedback-error-bg rounded-lg p-3"
        >
          {t('triggers.cron.intervalTooShort')}
        </div>
      )}

      {/* Cost warning (< 60 minutes) — allows submit with confirmation */}
      {isValid && !intervalTooShort && showCostWarning && (
        <div
          role="alert"
          className="flex gap-3 rounded-lg border border-feedback-warning-border bg-feedback-warning-bg p-3"
        >
          <AlertTriangle className="shrink-0 text-feedback-warning" size={20} aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold text-feedback-warning">
              {t('triggers.cron.costWarning.title')}
            </p>
            <p className="mt-1 text-fg-secondary">{t('triggers.cron.costWarning.body')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
