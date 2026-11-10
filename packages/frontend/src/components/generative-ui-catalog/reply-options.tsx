import React from 'react';
import { Check } from 'lucide-react';

/** Radio (pick one) vs checkbox (pick several) — tells the two modes apart at a glance. */
const SelectionIndicator = ({
  multiSelect,
  checked,
}: {
  multiSelect: boolean;
  checked: boolean;
}) =>
  multiSelect ? (
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

interface ReplyOptionRowProps {
  label: string;
  description?: string;
  multiSelect: boolean;
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Lighter dashed style for the free-form "Other" row. */
  variant?: 'option' | 'other';
}

export const ReplyOptionRow = ({
  label,
  description,
  multiSelect,
  checked,
  disabled,
  onClick,
  variant = 'option',
}: ReplyOptionRowProps): React.ReactNode => (
  <button
    type="button"
    disabled={disabled}
    role={multiSelect ? 'checkbox' : 'radio'}
    aria-checked={checked}
    onClick={onClick}
    className={`flex items-start gap-3 w-full text-left rounded-md border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary ${
      checked
        ? 'border-action-primary bg-surface-secondary'
        : `${variant === 'other' ? 'border-dashed' : ''} border-border bg-surface-primary`
    } ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-surface-secondary'} ${
      disabled && !checked ? 'opacity-60' : ''
    }`}
  >
    <SelectionIndicator multiSelect={multiSelect} checked={checked} />
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
