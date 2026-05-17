/**
 * Toggle Atom Component
 * Accessible toggle switch for boolean settings.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface ToggleProps {
  /** Current state */
  checked: boolean;
  /** Change handler */
  onChange: (checked: boolean) => void;
  /** Disable interaction */
  disabled?: boolean;
  /** Show loading spinner */
  loading?: boolean;
  /** Accessible label */
  label?: string;
  /** Additional class names */
  className?: string;
}

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  loading = false,
  label,
  className,
}) => {
  const isDisabled = disabled || loading;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={isDisabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent',
        'transition-colors duration-200 ease-in-out',
        'focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2',
        'disabled:opacity-70 disabled:cursor-not-allowed',
        checked ? 'bg-action-primary' : 'bg-border',
        className
      )}
    >
      {loading ? (
        <span className="inline-flex w-full items-center justify-center">
          <Loader2 className="w-3 h-3 text-fg-inverse animate-spin" />
        </span>
      ) : (
        <span
          className={cn(
            'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-surface-primary shadow ring-0',
            'transition duration-200 ease-in-out',
            checked ? 'translate-x-5' : 'translate-x-0'
          )}
        />
      )}
    </button>
  );
};
