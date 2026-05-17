/**
 * InputMessageConfig Component
 *
 * Input message configuration for trigger
 */

import { useTranslation } from 'react-i18next';

export interface InputMessageConfigProps {
  inputMessage: string;
  onChange: (message: string) => void;
  disabled?: boolean;
}

export function InputMessageConfig({
  inputMessage,
  onChange,
  disabled = false,
}: InputMessageConfigProps) {
  const { t } = useTranslation();

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-fg-default">
          {t('triggers.form.inputMessage')} <span className="text-feedback-error">*</span>
        </h3>
        <p className="text-sm text-fg-muted mt-1">{t('triggers.form.inputMessageDescription')}</p>
      </div>

      <div>
        <textarea
          value={inputMessage}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('triggers.form.inputMessagePlaceholder')}
          disabled={disabled}
          maxLength={2000}
          rows={6}
          className="w-full px-3 py-2 bg-surface-primary border border-border-strong rounded-lg focus:outline-none focus:ring-2 focus:ring-border-focus resize-none disabled:bg-surface-secondary disabled:cursor-not-allowed font-mono text-sm"
        />
        <div className="flex justify-end items-center mt-2">
          <p className="text-xs text-fg-muted">{inputMessage.length} / 2000</p>
        </div>
      </div>
    </div>
  );
}
