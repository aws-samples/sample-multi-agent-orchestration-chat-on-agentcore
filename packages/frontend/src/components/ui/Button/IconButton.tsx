/**
 * IconButton Atom Component
 * Icon-only button commonly used in headers, toolbars, and sidebars.
 */

import React from 'react';
import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon to display */
  icon: LucideIcon;
  /** Visual style variant */
  variant?: 'ghost' | 'subtle' | 'outline';
  /** Button size */
  size?: 'sm' | 'md' | 'lg';
  /** Accessible label (required for icon-only buttons) */
  label: string;
  /** Show loading spinner */
  loading?: boolean;
}

const variantStyles: Record<NonNullable<IconButtonProps['variant']>, string> = {
  ghost:
    'text-fg-secondary hover:text-fg-default hover:bg-surface-secondary focus:ring-border-focus/20',
  subtle:
    'text-fg-muted hover:text-fg-secondary hover:bg-surface-secondary focus:ring-border-focus/20',
  outline:
    'text-fg-secondary border border-border hover:bg-surface-secondary focus:ring-border-focus/20',
};

const sizeStyles: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'p-1',
  md: 'p-2',
  lg: 'p-2.5',
};

const iconSizes: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'w-4 h-4',
  md: 'w-5 h-5',
  lg: 'w-5 h-5',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon: Icon,
      variant = 'ghost',
      size = 'md',
      label,
      loading = false,
      disabled,
      className,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-label={label}
        title={label}
        className={cn(
          // Base styles
          'inline-flex items-center justify-center rounded-btn transition-colors duration-200',
          'focus:outline-none focus:ring-2 focus:ring-offset-1',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'flex-shrink-0',
          // Variant
          variantStyles[variant],
          // Size
          sizeStyles[size],
          className
        )}
        {...props}
      >
        {loading ? (
          <Loader2 className={cn('animate-spin', iconSizes[size])} />
        ) : (
          <Icon className={iconSizes[size]} />
        )}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
