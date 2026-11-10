import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import type { BaseComponentProps } from '@json-render/react';
import type { SuggestedRepliesProps } from '@moca/generative-ui-catalog';
import { useGenerativeUiInteraction } from './interaction-context';
import { focusMessageInput, submitMessageInput } from '../../utils/message-input-events';
import { OtherAnswerInput, ReplyOptionRow } from './reply-options';
import { replyText } from './reply-option';

const SuggestedReplies = ({
  props,
}: BaseComponentProps<SuggestedRepliesProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { interactive } = useGenerativeUiInteraction();
  const { question, options = [], multiSelect = false, allowOther = true } = props;
  const [selected, setSelected] = useState<number[]>([]);
  const [otherChecked, setOtherChecked] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [sent, setSent] = useState(false);
  const disabled = !interactive || sent;

  const send = (texts: string[]) => {
    if (disabled || texts.length === 0) return false;
    // Lock only once MessageInput accepts; a refused send leaves the choices usable.
    if (!submitMessageInput(texts.join('\n'))) return false;
    setSent(true);
    return true;
  };

  const handleOptionClick = (index: number) => {
    if (disabled) return;
    if (!multiSelect) {
      if (send([replyText(options[index])])) setSelected([index]);
      return;
    }
    setSelected((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  // Multi-select keeps "Other" inline so the ticked options go out with it;
  // single-select hands off to the chat input, where a typed reply is natural.
  const multiTexts = [
    ...[...selected].sort((a, b) => a - b).map((i) => replyText(options[i])),
    ...(otherChecked && otherText.trim() ? [otherText.trim()] : []),
  ];
  const canSendMulti = multiTexts.length > 0 && (!otherChecked || otherText.trim() !== '');

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
        {options.map((option, index) => (
          <ReplyOptionRow
            key={index}
            label={option.label}
            description={option.description}
            kind={multiSelect ? 'checkbox' : 'radio'}
            checked={selected.includes(index)}
            disabled={disabled}
            onClick={() => handleOptionClick(index)}
          />
        ))}

        {allowOther &&
          (multiSelect ? (
            <ReplyOptionRow
              variant="other"
              kind="checkbox"
              label={t('generativeUi.suggestedReplies.other')}
              checked={otherChecked}
              disabled={disabled}
              onClick={() => setOtherChecked((v) => !v)}
            />
          ) : (
            <ReplyOptionRow
              variant="other"
              kind="action"
              label={t('generativeUi.suggestedReplies.other')}
              disabled={disabled}
              onClick={focusMessageInput}
            />
          ))}
        {multiSelect && otherChecked && (
          <OtherAnswerInput
            value={otherText}
            placeholder={t('generativeUi.questionnaire.otherPlaceholder')}
            disabled={disabled}
            onChange={setOtherText}
            onEnter={() => canSendMulti && send(multiTexts)}
          />
        )}
      </div>

      {multiSelect && !disabled && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!canSendMulti}
            onClick={() => send(multiTexts)}
            className="inline-flex items-center gap-1.5 rounded-md bg-action-primary px-3 py-1.5 text-sm font-medium text-action-primary-fg transition-colors hover:bg-action-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send size={14} aria-hidden="true" />
            {t('generativeUi.suggestedReplies.send', { count: multiTexts.length })}
          </button>
        </div>
      )}
    </div>
  );
};

export default SuggestedReplies;
