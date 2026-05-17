/**
 * CronPresetButtons Component
 *
 * Preset buttons for common cron expressions
 */

import { useTranslation } from 'react-i18next';
import { CRON_PRESETS } from './cronUtils';

export interface CronPresetButtonsProps {
  /**
   * Currently selected cron expression
   */
  selectedExpression: string;

  /**
   * Callback when a preset is selected
   */
  onSelect: (expression: string) => void;

  /**
   * Callback when custom mode is selected
   */
  onCustom: () => void;

  /**
   * Whether custom mode is active
   */
  isCustom?: boolean;

  /**
   * Whether buttons are disabled
   */
  disabled?: boolean;
}

export function CronPresetButtons({
  selectedExpression,
  onSelect,
  onCustom,
  isCustom = false,
  disabled = false,
}: CronPresetButtonsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap gap-2">
      {CRON_PRESETS.map((preset) => {
        const isSelected = selectedExpression === preset.expression;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onSelect(preset.expression)}
            disabled={disabled}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              isSelected
                ? 'bg-action-primary text-white'
                : 'bg-surface-secondary text-fg-secondary hover:bg-border'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {t(preset.label)}
          </button>
        );
      })}

      {/* Custom Button */}
      <button
        type="button"
        onClick={onCustom}
        disabled={disabled}
        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          isCustom
            ? 'bg-action-primary text-white'
            : 'bg-surface-secondary text-fg-secondary hover:bg-border'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {t('triggers.cron.presetCustom')}
      </button>
    </div>
  );
}
