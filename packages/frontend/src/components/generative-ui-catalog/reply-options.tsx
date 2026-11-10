import React from 'react';
import { Check, PencilLine } from 'lucide-react';

/**
 * radio: pick one. checkbox: pick several. action: a plain button (e.g. "Other"
 * that hands off to the chat input) — no selection state, so no indicator.
 */
export type ReplyOptionKind = 'radio' | 'checkbox' | 'action';

const SelectionIndicator = ({ kind, checked }: { kind: ReplyOptionKind; checked: boolean }) => {
  if (kind === 'action') {
    return <PencilLine size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />;
  }
  return kind === 'checkbox' ? (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-2 transition-colors ${
        checked
          ? 'border-action-primary bg-action-primary text-action-primary-fg'
          : 'border-fg-muted bg-surface-primary'
      }`}
      aria-hidden="true"
    >
      {checked && <Check size={12} strokeWidth={3} />}
    </span>
  ) : (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
        checked ? 'border-action-primary' : 'border-fg-muted'
      } bg-surface-primary`}
      aria-hidden="true"
    >
      {checked && <span className="h-2 w-2 rounded-full bg-action-primary" />}
    </span>
  );
};

interface ReplyOptionRowProps {
  label: string;
  description?: string;
  kind: ReplyOptionKind;
  checked?: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Lighter dashed style for the free-form "Other" row. */
  variant?: 'option' | 'other';
}

export const ReplyOptionRow = ({
  label,
  description,
  kind,
  checked = false,
  disabled,
  onClick,
  variant = 'option',
}: ReplyOptionRowProps): React.ReactNode => (
  <button
    type="button"
    disabled={disabled}
    role={kind === 'action' ? undefined : kind}
    aria-checked={kind === 'action' ? undefined : checked}
    onClick={onClick}
    className={`flex items-start gap-3 w-full text-left rounded-md border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${
      checked
        ? 'border-action-primary bg-surface-secondary'
        : `${variant === 'other' ? 'border-dashed' : ''} border-border bg-surface-primary`
    } ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-surface-secondary'} ${
      disabled && !checked ? 'opacity-60' : ''
    }`}
  >
    <SelectionIndicator kind={kind} checked={checked} />
    <span className="flex flex-col gap-0.5 min-w-0">
      <span
        className={`text-sm break-words ${variant === 'other' ? 'text-fg-muted' : 'font-medium text-fg-default'}`}
      >
        {label}
      </span>
      {description && <span className="text-xs text-fg-muted break-words">{description}</span>}
    </span>
  </button>
);

interface OtherAnswerInputProps {
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
  /** Enter (outside IME composition) — e.g. advance or send. */
  onEnter?: () => void;
}

export const OtherAnswerInput = ({
  value,
  placeholder,
  disabled,
  onChange,
  onEnter,
}: OtherAnswerInputProps): React.ReactNode => (
  <input
    type="text"
    autoFocus={!disabled}
    disabled={disabled}
    value={value}
    placeholder={placeholder}
    aria-label={placeholder}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.key !== 'Enter' || !onEnter) return;
      e.preventDefault();
      onEnter();
    }}
    className="w-full rounded-md border border-border bg-surface-primary px-3 py-2 text-sm text-fg-default placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-action-primary disabled:opacity-60"
  />
);
