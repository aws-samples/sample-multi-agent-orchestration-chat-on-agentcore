/**
 * Card Atom Component
 * Container component with consistent styling for content sections.
 */

import React from 'react';
import { cn } from '../../../lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Visual variant */
  variant?: 'default' | 'elevated' | 'muted';
  /** Padding size */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Enable hover effects for interactive cards */
  interactive?: boolean;
}

const variantStyles: Record<NonNullable<CardProps['variant']>, string> = {
  default: 'bg-surface-primary border border-border',
  elevated: 'bg-surface-elevated border border-border shadow-elevation-2',
  muted: 'bg-surface-secondary border border-border',
};

const paddingStyles: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    { variant = 'default', padding = 'md', interactive = false, className, children, ...props },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-card',
          variantStyles[variant],
          paddingStyles[padding],
          interactive &&
            'cursor-pointer hover:border-border-strong hover:shadow-elevation-2 transition-all',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';
