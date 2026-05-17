/**
 * Button Atom Component
 * Reusable button with multiple variants, sizes, and states.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Show loading spinner */
  loading?: boolean;
  /** Icon displayed before children */
  leftIcon?: LucideIcon;
  /** Icon displayed after children */
  rightIcon?: LucideIcon;
  /** Make button full width */
  fullWidth?: boolean;
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-action-primary text-action-primary-fg hover:bg-action-primary-hover focus:ring-action-primary/30',
  secondary:
    'bg-surface-secondary text-fg-default border border-border hover:bg-surface-secondary focus:ring-border-focus/20',
  ghost:
    'bg-transparent text-fg-secondary hover:bg-surface-secondary hover:text-fg-default focus:ring-border-focus/20',
  danger:
    'bg-action-danger text-action-danger-fg hover:bg-action-danger-hover focus:ring-action-danger/30',
  outline:
    'bg-surface-primary text-fg-default border border-border-strong hover:bg-surface-secondary focus:ring-border-focus/20',
};

const sizeStyles: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-6 py-3 text-base gap-2',
};

const iconSizes: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon: LeftIcon,
      rightIcon: RightIcon,
      fullWidth = false,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={cn(
          // Base styles
          'inline-flex items-center justify-center font-medium rounded-btn transition-colors duration-200',
          'focus:outline-none focus:ring-2 focus:ring-offset-1',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          // Variant
          variantStyles[variant],
          // Size
          sizeStyles[size],
          // Full width
          fullWidth && 'w-full',
          className
        )}
        {...props}
      >
        {loading ? (
          <Loader2 className={cn('animate-spin', iconSizes[size])} />
        ) : (
          LeftIcon && <LeftIcon className={iconSizes[size]} />
        )}
        {children}
        {!loading && RightIcon && <RightIcon className={iconSizes[size]} />}
      </button>
    );
  }
);

Button.displayName = 'Button';
