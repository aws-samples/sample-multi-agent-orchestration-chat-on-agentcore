import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PencilLine, Send } from 'lucide-react';
import type { BaseComponentProps } from '@json-render/react';
import { useGenerativeUiInteraction } from './interaction-context';
import { focusMessageInput, submitMessageInput } from '../../utils/message-input-events';
import { ReplyOptionRow } from './reply-options';
import { replyText } from './reply-option';
import type { ReplyOption } from './reply-option';

interface SuggestedRepliesProps {
  question?: string;
  options: ReplyOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
}

const SuggestedReplies = ({
  props,
}: BaseComponentProps<SuggestedRepliesProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { interactive } = useGenerativeUiInteraction();
  const { question, options = [], multiSelect = false, allowOther = true } = props;
  const [selected, setSelected] = useState<number[]>([]);
  const [sent, setSent] = useState(false);
  const disabled = !interactive || sent;

  const send = (indices: number[]) => {
    if (disabled || indices.length === 0) return;
    setSent(true);
    submitMessageInput(indices.map((i) => replyText(options[i])).join('\n'));
  };

  const handleOptionClick = (index: number) => {
    if (disabled) return;
    if (!multiSelect) {
      setSelected([index]);
      send([index]);
      return;
    }
    setSelected((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  return (
    <div className="w-full rounded-lg border border-border bg-surface-primary p-3 flex flex-col gap-2">
      {question && <p className="m-0 text-sm font-semibold text-fg-default">{question}</p>}
      {multiSelect && !disabled && (
        <p className="m-0 text-xs text-fg-muted">{t('generativeUi.suggestedReplies.multiHint')}</p>
      )}

      <div
        className="flex flex-col gap-1.5"
        role={multiSelect ? 'group' : 'radiogroup'}
        aria-label={question}
      >
        {options.map((option, index) => {
          return (
            <ReplyOptionRow
              key={index}
              label={option.label}
              description={option.description}
              multiSelect={multiSelect}
              checked={selected.includes(index)}
              disabled={disabled}
              onClick={() => handleOptionClick(index)}
            />
          );
        })}

        {allowOther && (
          <button
            type="button"
            disabled={disabled}
            onClick={focusMessageInput}
            className={`flex items-center gap-3 w-full text-left rounded-md border border-dashed border-border px-3 py-2 text-sm text-fg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${
              disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-surface-secondary'
            }`}
          >
            <PencilLine size={14} className="mx-0.5 shrink-0" aria-hidden="true" />
            {t('generativeUi.suggestedReplies.other')}
          </button>
        )}
      </div>

      {multiSelect && !sent && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={disabled || selected.length === 0}
            onClick={() => send([...selected].sort((a, b) => a - b))}
            className="inline-flex items-center gap-1.5 rounded-md bg-action-primary px-3 py-1.5 text-sm font-medium text-action-primary-fg transition-colors hover:bg-action-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send size={14} aria-hidden="true" />
            {t('generativeUi.suggestedReplies.send', { count: selected.length })}
          </button>
        </div>
      )}
    </div>
  );
};

export default SuggestedReplies;
