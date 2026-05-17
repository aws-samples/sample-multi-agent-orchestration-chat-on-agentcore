/**
 * Input Atom Component
 * Reusable text input with icon support and error state.
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Error message to display */
  error?: string;
  /** Icon displayed on the left side */
  leftIcon?: LucideIcon;
  /** Element displayed on the right side (e.g., clear button) */
  rightElement?: React.ReactNode;
  /** Input size */
  inputSize?: 'sm' | 'md' | 'lg';
}

const sizeStyles: Record<NonNullable<InputProps['inputSize']>, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3 py-2 text-sm',
  lg: 'px-4 py-3 text-base',
};

const iconPaddingLeft: Record<NonNullable<InputProps['inputSize']>, string> = {
  sm: 'pl-8',
  md: 'pl-10',
  lg: 'pl-12',
};

const iconSizes: Record<NonNullable<InputProps['inputSize']>, string> = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

const iconPositions: Record<NonNullable<InputProps['inputSize']>, string> = {
  sm: 'left-2.5 top-1/2 -translate-y-1/2',
  md: 'left-3 top-1/2 -translate-y-1/2',
  lg: 'left-4 top-1/2 -translate-y-1/2',
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ error, leftIcon: LeftIcon, rightElement, inputSize = 'md', className, ...props }, ref) => {
    return (
      <div className="relative w-full">
        {LeftIcon && (
          <LeftIcon
            className={cn(
              'absolute text-fg-muted pointer-events-none',
              iconSizes[inputSize],
              iconPositions[inputSize]
            )}
          />
        )}
        <input
          ref={ref}
          className={cn(
            // Base styles
            'w-full border rounded-input bg-surface-primary text-fg-default',
            'placeholder:text-fg-disabled',
            'focus:outline-none focus:ring-2 focus:ring-border-focus focus:border-transparent',
            'disabled:bg-surface-secondary disabled:cursor-not-allowed disabled:text-fg-disabled',
            'transition-colors duration-200',
            // Size
            sizeStyles[inputSize],
            // Left icon padding
            LeftIcon && iconPaddingLeft[inputSize],
            // Right element padding
            rightElement && 'pr-10',
            // Error state
            error ? 'border-feedback-error focus:ring-feedback-error/30' : 'border-border',
            className
          )}
          {...props}
        />
        {rightElement && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2">{rightElement}</div>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
