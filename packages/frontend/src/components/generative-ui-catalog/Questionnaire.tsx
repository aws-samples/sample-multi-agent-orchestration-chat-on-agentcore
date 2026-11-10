import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, Send } from 'lucide-react';
import type { BaseComponentProps } from '@json-render/react';
import { useGenerativeUiInteraction } from './interaction-context';
import { submitMessageInput } from '../../utils/message-input-events';
import type {
  QuestionnaireProps,
  QuestionnaireQuestion as QuestionItem,
} from '@moca/generative-ui-catalog';
import { OtherAnswerInput, ReplyOptionRow } from './reply-options';
import { replyText } from './reply-option';

interface Answer {
  /** Option indices; `options.length` stands for the free-form "Other" entry. */
  selected: number[];
  other: string;
}

const EMPTY_ANSWER: Answer = { selected: [], other: '' };

const otherIndex = (q: QuestionItem) => q.options.length;

const isAnswered = (q: QuestionItem, a: Answer) =>
  a.selected.length > 0 && (!a.selected.includes(otherIndex(q)) || a.other.trim() !== '');

const answerTexts = (q: QuestionItem, a: Answer) =>
  [...a.selected]
    .sort((x, y) => x - y)
    .map((i) => (i === otherIndex(q) ? a.other.trim() : replyText(q.options[i])));

/** One message the agent can map back to each question without extra context. */
const formatAnswers = (questions: QuestionItem[], answers: Answer[]) =>
  questions
    .map((q, i) =>
      [`Q. ${q.question}`, ...answerTexts(q, answers[i]).map((t) => `- ${t}`)].join('\n')
    )
    .join('\n\n');

const Questionnaire = ({ props }: BaseComponentProps<QuestionnaireProps>): React.ReactNode => {
  const { t } = useTranslation();
  const { interactive } = useGenerativeUiInteraction();
  const { title } = props;
  // The agent validates props, but stay renderable for older stored specs.
  const questions = (props.questions ?? []).filter((q) => Array.isArray(q?.options));
  const total = questions.length;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => EMPTY_ANSWER));
  const [sent, setSent] = useState(false);
  const locked = !interactive || sent;
  // A history view (no local answers) has nothing to review — hide that step
  // instead of showing every answer as empty with a call to send.
  const showReview = !locked || sent;

  if (total === 0) return null;

  const answerAt = (i: number) => answers[i] ?? EMPTY_ANSWER;
  const firstUnanswered = questions.findIndex((q, i) => !isAnswered(q, answerAt(i)));
  const allAnswered = firstUnanswered === -1;
  const reviewStep = total;
  // While answering, only steps up to the first unanswered question are reachable;
  // read-only (history / sent) views can be browsed freely.
  const canVisit = (s: number) =>
    locked || (s === reviewStep ? allAnswered : s <= (allAnswered ? total : firstUnanswered));

  // Functional updates so rapid successive clicks never act on a stale answer.
  const updateAnswer = (i: number, update: (current: Answer) => Answer) =>
    setAnswers((prev) => prev.map((a, j) => (j === i ? update(a ?? EMPTY_ANSWER) : a)));

  const handleOptionClick = (qIndex: number, optionIndex: number) => {
    if (locked) return;
    const q = questions[qIndex];
    if (q.multiSelect) {
      updateAnswer(qIndex, (current) => ({
        ...current,
        selected: current.selected.includes(optionIndex)
          ? current.selected.filter((i) => i !== optionIndex)
          : [...current.selected, optionIndex],
      }));
      return;
    }
    updateAnswer(qIndex, (current) => ({ ...current, selected: [optionIndex] }));
    // Single choice advances like Claude Code; "Other" waits for the typed answer.
    if (optionIndex !== otherIndex(q)) setStep(qIndex + 1);
  };

  const submit = () => {
    if (locked || !allAnswered) return;
    // Lock only once MessageInput accepts; a refused send keeps the answers editable.
    if (submitMessageInput(formatAnswers(questions, answers))) setSent(true);
  };

  const tabLabel = (q: QuestionItem, i: number) =>
    q.header?.trim() || t('generativeUi.questionnaire.questionLabel', { n: i + 1 });

  const renderQuestion = (qIndex: number) => {
    const q = questions[qIndex];
    const multiSelect = Boolean(q.multiSelect);
    const answer = answerAt(qIndex);
    const otherSelected = answer.selected.includes(otherIndex(q));
    return (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-xs text-fg-muted">
          {t('generativeUi.questionnaire.progress', { current: qIndex + 1, total })}
        </p>
        <p className="m-0 text-sm font-semibold text-fg-default">{q.question}</p>
        {multiSelect && !locked && (
          <p className="m-0 text-xs text-fg-muted">{t('generativeUi.questionnaire.multiHint')}</p>
        )}
        <div
          className="flex flex-col gap-1.5"
          role={multiSelect ? 'group' : 'radiogroup'}
          aria-label={q.question}
        >
          {q.options.map((option, i) => (
            <ReplyOptionRow
              key={i}
              label={option.label}
              description={option.description}
              kind={multiSelect ? 'checkbox' : 'radio'}
              checked={answer.selected.includes(i)}
              disabled={locked}
              onClick={() => handleOptionClick(qIndex, i)}
            />
          ))}
          {q.allowOther !== false && (
            <ReplyOptionRow
              variant="other"
              label={t('generativeUi.suggestedReplies.other')}
              kind={multiSelect ? 'checkbox' : 'radio'}
              checked={otherSelected}
              disabled={locked}
              onClick={() => handleOptionClick(qIndex, otherIndex(q))}
            />
          )}
          {otherSelected && (
            <OtherAnswerInput
              value={answer.other}
              placeholder={t('generativeUi.questionnaire.otherPlaceholder')}
              disabled={locked}
              onChange={(other) => updateAnswer(qIndex, (current) => ({ ...current, other }))}
              onEnter={() => isAnswered(q, answer) && setStep(qIndex + 1)}
            />
          )}
        </div>
      </div>
    );
  };

  const renderReview = () => (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-xs text-fg-muted">
        {sent ? t('generativeUi.questionnaire.sent') : t('generativeUi.questionnaire.reviewTitle')}
      </p>
      <dl className="m-0 flex flex-col gap-2">
        {questions.map((q, i) => (
          <div key={i} className="rounded-md border border-border px-3 py-2">
            <dt className="text-xs text-fg-muted">{q.question}</dt>
            <dd className="m-0 mt-0.5 text-sm font-medium text-fg-default whitespace-pre-wrap break-words">
              {answerTexts(q, answerAt(i)).join('\n') || '—'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );

  const onReview = step === reviewStep;
  const currentAnswered = !onReview && isAnswered(questions[step], answerAt(step));
  const navButton =
    'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="w-full rounded-lg border border-border bg-surface-primary p-3 flex flex-col gap-3">
      {title && <p className="m-0 text-sm font-semibold text-fg-default">{title}</p>}

      <nav className="flex flex-wrap gap-1.5" aria-label={title}>
        {[
          ...questions.map((q, i) => tabLabel(q, i)),
          ...(showReview ? [t('generativeUi.questionnaire.review')] : []),
        ].map((label, s) => {
          const done = s < total && isAnswered(questions[s], answerAt(s));
          return (
            <button
              key={s}
              type="button"
              disabled={!canVisit(s)}
              aria-current={s === step ? 'step' : undefined}
              onClick={() => setStep(s)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                s === step
                  ? 'border-action-primary bg-action-primary text-action-primary-fg'
                  : 'border-border bg-surface-primary text-fg-secondary hover:bg-surface-secondary'
              }`}
            >
              {done && <Check size={12} aria-hidden="true" />}
              {label}
            </button>
          );
        })}
      </nav>

      {onReview ? renderReview() : renderQuestion(step)}

      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={step === 0}
          onClick={() => setStep(step - 1)}
          className={`${navButton} text-fg-secondary hover:bg-surface-secondary ${step === 0 ? 'invisible' : ''}`}
        >
          <ChevronLeft size={14} aria-hidden="true" />
          {t('generativeUi.questionnaire.back')}
        </button>
        {onReview ? (
          !sent && (
            <button
              type="button"
              disabled={locked || !allAnswered}
              onClick={submit}
              className={`${navButton} bg-action-primary text-action-primary-fg hover:bg-action-primary-hover`}
            >
              <Send size={14} aria-hidden="true" />
              {t('generativeUi.questionnaire.submit')}
            </button>
          )
        ) : showReview || step < total - 1 ? (
          <button
            type="button"
            disabled={!(locked || currentAnswered)}
            onClick={() => setStep(step + 1)}
            className={`${navButton} bg-action-primary text-action-primary-fg hover:bg-action-primary-hover`}
          >
            {step === total - 1
              ? t('generativeUi.questionnaire.toReview')
              : t('generativeUi.questionnaire.next')}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
};

export default Questionnaire;
