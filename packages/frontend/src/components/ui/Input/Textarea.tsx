/**
 * Textarea Atom Component
 * Reusable textarea with error state and resize control.
 */

import React from 'react';
import { cn } from '../../../lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Error message to display */
  error?: string;
  /** Resize behavior */
  resize?: 'none' | 'vertical' | 'both';
  /** Use monospace font */
  mono?: boolean;
}

const resizeStyles: Record<NonNullable<TextareaProps['resize']>, string> = {
  none: 'resize-none',
  vertical: 'resize-y',
  both: 'resize',
};

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, resize = 'vertical', mono = false, className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          // Base styles
          'w-full px-3 py-2 text-sm border rounded-input bg-surface-primary text-fg-default',
          'placeholder:text-fg-disabled',
          'focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent',
          'disabled:bg-surface-secondary disabled:cursor-not-allowed disabled:text-fg-disabled',
          'transition-colors duration-200',
          // Resize
          resizeStyles[resize],
          // Mono font
          mono && 'font-mono',
          // Error state
          error ? 'border-feedback-error focus:ring-feedback-error/30' : 'border-border',
          className
        )}
        {...props}
      />
    );
  }
);

Textarea.displayName = 'Textarea';
