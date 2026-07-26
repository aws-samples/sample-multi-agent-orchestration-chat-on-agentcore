/**
 * GoalModal
 *
 * Goal editor opened from the goal button in the chat input. Lets the user set
 * a natural-language goal (the GoalLoop refinement criterion), optionally pick
 * the judge model and the retry (attempt) cap, and choose whether the goal
 * should stick across sends ("継続適用" — persisted to localStorage via
 * settingsStore; the wire contract stays per-message).
 *
 * Draft-commit semantics: the modal edits a LOCAL draft seeded from the
 * committed values each time it opens. Only "Set" commits the draft to the
 * parent (and to the persisted sticky goal); dismissing via ESC / overlay / ×
 * discards the draft entirely. WHY: a live-controlled editor had two real
 * failure modes — a goal typed then abandoned with ESC still ran GoalLoop on
 * the next send (unwanted judge cost), and unchecking sticky then dismissing
 * silently reverted on the next mount because localStorage was never updated.
 * With draft-commit, dismiss is always a no-op and the UI never diverges from
 * what is actually committed/persisted.
 */

import React, { useState } from 'react';
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

/** Keys under chat.goal.examples.* — each has a `label` and a `text`. */
const EXAMPLE_KEYS = ['review', 'factcheck', 'coding'] as const;

/** The values the modal edits and commits as one unit. */
export interface GoalDraft {
  text: string;
  /** Judge model id, or undefined for the server default. */
  judgeModelId: string | undefined;
  /** Attempt cap, or undefined for the server default. */
  maxAttempts: number | undefined;
  /** Whether the goal keeps applying to future sends. */
  sticky: boolean;
}

export interface GoalModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Committed values used to seed the draft each time the modal opens. */
  committed: GoalDraft;
  /** Commit the draft (Set button). The parent owns persistence. */
  onCommit: (draft: GoalDraft) => void;
  /** Reset goal + judge model + attempts + sticky persistence (Clear button). */
  onClear: () => void;
}

export const GoalModal: React.FC<GoalModalProps> = ({
  isOpen,
  onClose,
  committed,
  onCommit,
  onClear,
}) => {
  const { t } = useTranslation();

  // Local draft, re-seeded from the committed values on every open so a
  // previously discarded edit never leaks into the next editing session.
  // Re-seeding uses the render-phase "adjust state when a prop changes"
  // pattern (not an effect): `committed` is intentionally read only at the
  // open transition — mid-edit external changes must not clobber the draft.
  const [draft, setDraft] = useState<GoalDraft>(committed);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setDraft(committed);
  }

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
              value={draft.text}
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              rows={6}
              resize="vertical"
            />
          </FormField>

          {/* Example goal chips: clicking one replaces the goal text so users
              can start from a concrete, working criterion instead of a blank
              box. Title-only chips — the full checklist shows in the hover
              tooltip and lands in the textarea on click. */}
          <div>
            <p className="text-xs text-fg-muted mb-1.5">{t('chat.goal.examplesLabel')}</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, text: t(`chat.goal.examples.${key}.text`) }))}
                  title={t(`chat.goal.examples.${key}.text`)}
                  className="px-2.5 py-1 text-xs rounded-full border border-border text-fg-secondary hover:bg-surface-secondary hover:text-fg-default transition-colors"
                >
                  {t(`chat.goal.examples.${key}.label`)}
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
                value={draft.judgeModelId ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, judgeModelId: e.target.value || undefined }))
                }
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
                value={draft.maxAttempts ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    maxAttempts: e.target.value ? Number(e.target.value) : undefined,
                  }))
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
              checked={draft.sticky}
              onChange={(e) => setDraft((d) => ({ ...d, sticky: e.target.checked }))}
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
        <Button variant="primary" size="md" onClick={() => onCommit(draft)}>
          {t('chat.goal.set')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};
