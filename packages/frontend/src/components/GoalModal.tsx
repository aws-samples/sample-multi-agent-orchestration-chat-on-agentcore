/**
 * GoalModal
 *
 * Per-message goal editor. Opened from the goal button beside the chat send
 * button. Lets the user set a natural-language goal (the GoalLoop refinement
 * criterion for the next send), optionally pick the judge model and the retry
 * (attempt) cap, and choose whether the goal should stick across sends
 * ("継続適用" — persisted to localStorage via settingsStore; the wire contract
 * stays per-message).
 *
 * State lives in MessageInput; this component is a controlled editor over
 * `value` / `judgeModelId` / `maxAttempts` / `sticky`. "Set" commits the
 * sticky choice (via onSet) and closes; "Clear" resets everything (including
 * the persisted sticky goal) and closes.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { Textarea } from './ui/Input/Textarea';
import { AVAILABLE_MODELS } from '../config/models';

/**
 * Selectable attempt caps. Mirrors the agent-side clamp range
 * [GOAL_LOOP_ATTEMPTS_MIN, GOAL_LOOP_ATTEMPTS_MAX] — values outside it would
 * be clamped by the server anyway, so don't offer them.
 */
const MAX_ATTEMPTS_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Keys under chat.goal.examples.* — each has a `label`, a `hint`, and a `text`. */
const EXAMPLE_KEYS = ['review', 'factcheck', 'coding'] as const;

export interface GoalModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current goal text. */
  value: string;
  onChange: (value: string) => void;
  /** Selected judge model id, or undefined for the server default. */
  judgeModelId: string | undefined;
  onJudgeModelChange: (modelId: string | undefined) => void;
  /** Attempt cap for the GoalLoop, or undefined for the server default. */
  maxAttempts: number | undefined;
  onMaxAttemptsChange: (maxAttempts: number | undefined) => void;
  /** Whether the goal should keep applying to future sends. */
  sticky: boolean;
  onStickyChange: (sticky: boolean) => void;
  /** Commit the current values (incl. sticky persistence) and close. */
  onSet: () => void;
  /** Reset goal + judge model + attempts + sticky persistence. */
  onClear: () => void;
}

export const GoalModal: React.FC<GoalModalProps> = ({
  isOpen,
  onClose,
  value,
  onChange,
  judgeModelId,
  onJudgeModelChange,
  maxAttempts,
  onMaxAttemptsChange,
  sticky,
  onStickyChange,
  onSet,
  onClear,
}) => {
  const { t } = useTranslation();

  return (
    // `lg` + a widened max-w: the goal textarea and example chips need more
    // room than the default lg width, but `xl` (90vw / min-h-70vh) is far too
    // large for a single-field editor.
    <Modal isOpen={isOpen} onClose={onClose} size="lg" className="w-full max-w-2xl">
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
              rows={6}
              resize="vertical"
            />
          </FormField>

          {/* Example goals: clicking one replaces the goal text so users can
              start from a concrete, working criterion instead of a blank box.
              The example texts are multi-line condition checklists, so each
              entry shows a label + one-line hint instead of a bare chip. */}
          <div>
            <p className="text-xs text-fg-muted mb-1.5">{t('chat.goal.examplesLabel')}</p>
            <div className="space-y-1.5">
              {EXAMPLE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onChange(t(`chat.goal.examples.${key}.text`))}
                  title={t(`chat.goal.examples.${key}.text`)}
                  className="w-full text-left px-3 py-2 rounded-input border border-border hover:bg-surface-secondary transition-colors"
                >
                  <span className="block text-xs font-medium text-fg-default">
                    {t(`chat.goal.examples.${key}.label`)}
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {t(`chat.goal.examples.${key}.hint`)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Judge model + retry cap side by side — both are "loop tuning"
              knobs and each fits in half the widened modal. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

            <FormField label={t('chat.goal.maxAttemptsLabel')} htmlFor="goal-max-attempts">
              <select
                id="goal-max-attempts"
                aria-label={t('chat.goal.maxAttemptsLabel')}
                // Empty string = server default; map to/from `undefined` on the wire.
                value={maxAttempts ?? ''}
                onChange={(e) =>
                  onMaxAttemptsChange(e.target.value ? Number(e.target.value) : undefined)
                }
                className="w-full px-3 py-2 text-sm border border-border rounded-input bg-surface-primary text-fg-default focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent transition-colors duration-200"
              >
                <option value="">{t('chat.goal.maxAttemptsDefault')}</option>
                {MAX_ATTEMPTS_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {t('chat.goal.maxAttemptsOption', { count: n })}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <p className="text-xs text-fg-muted">{t('chat.goal.maxAttemptsNote')}</p>

          {/* Sticky flag: keep applying this goal to every future send until
              cleared. Every goal turn costs judge calls + refinement re-runs,
              so this is opt-in and clearly labeled. */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sticky}
              onChange={(e) => onStickyChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-action-primary"
              aria-describedby="goal-sticky-note"
            />
            <span className="text-sm text-fg-default">
              {t('chat.goal.sticky')}
              <span id="goal-sticky-note" className="block text-xs text-fg-muted">
                {t('chat.goal.stickyNote')}
              </span>
            </span>
          </label>
        </div>
      </Modal.Content>

      <Modal.Footer>
        <Button variant="ghost" size="md" onClick={onClear}>
          {t('chat.goal.clear')}
        </Button>
        <Button variant="primary" size="md" onClick={onSet}>
          {t('chat.goal.set')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
