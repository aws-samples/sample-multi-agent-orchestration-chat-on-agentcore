/**
 * GoalModal
 *
 * Per-message goal editor. Opened from the goal button beside the chat send
 * button. Lets the user set a natural-language goal (the GoalLoop refinement
 * criterion for the next send) and optionally pick the judge model.
 *
 * State lives in MessageInput (transient per-message); this component is a
 * controlled editor over `value` / `judgeModelId`. "Set" simply closes the
 * modal (the values are already lifted); "Clear" resets both and closes.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { Textarea } from './ui/Input/Textarea';
import { AVAILABLE_MODELS } from '../config/models';

export interface GoalModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current goal text. */
  value: string;
  onChange: (value: string) => void;
  /** Selected judge model id, or undefined for the server default. */
  judgeModelId: string | undefined;
  onJudgeModelChange: (modelId: string | undefined) => void;
  /** Reset goal + judge model to empty/default. */
  onClear: () => void;
}

export const GoalModal: React.FC<GoalModalProps> = ({
  isOpen,
  onClose,
  value,
  onChange,
  judgeModelId,
  onJudgeModelChange,
  onClear,
}) => {
  const { t } = useTranslation();

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <Modal.Header>
        <Modal.Title>{t('chat.goal.modalTitle')}</Modal.Title>
        <Modal.CloseButton />
      </Modal.Header>

      <Modal.Content>
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">{t('chat.goal.modalDescription')}</p>

          <FormField label={t('chat.goal.inputLabel')} htmlFor="goal-input">
            <Textarea
              id="goal-input"
              aria-label={t('chat.goal.inputLabel')}
              placeholder={t('chat.goal.placeholder')}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={4}
              resize="vertical"
            />
          </FormField>

          <FormField label={t('chat.goal.judgeModelLabel')} htmlFor="goal-judge-model">
            <select
              id="goal-judge-model"
              aria-label={t('chat.goal.judgeModelLabel')}
              // Empty string = server default; map to/from `undefined` on the wire.
              value={judgeModelId ?? ''}
              onChange={(e) => onJudgeModelChange(e.target.value || undefined)}
              className="w-full px-3 py-2 text-sm border border-border rounded-input bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent transition-colors duration-200"
            >
              <option value="">{t('chat.goal.judgeModelDefault')}</option>
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>
      </Modal.Content>

      <Modal.Footer>
        <Button variant="ghost" size="md" onClick={onClear}>
          {t('chat.goal.clear')}
        </Button>
        <Button variant="primary" size="md" onClick={onClose}>
          {t('chat.goal.set')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
