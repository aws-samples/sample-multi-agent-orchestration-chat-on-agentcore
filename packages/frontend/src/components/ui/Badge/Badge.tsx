/**
 * Badge Atom Component
 * Small label for status indicators and tags.
 */

import React from 'react';
import { cn } from '../../../lib/utils';

export interface BadgeProps {
  /** Visual variant */
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  /** Badge size */
  size?: 'sm' | 'md';
  /** Badge content */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
}

const variantStyles: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-surface-secondary text-fg-secondary',
  success: 'bg-feedback-success-bg text-feedback-success',
  warning: 'bg-feedback-warning-bg text-feedback-warning',
  danger: 'bg-feedback-error-bg text-feedback-error',
  info: 'bg-feedback-info-bg text-feedback-info',
};

const sizeStyles: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
};

export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'md',
  children,
  className,
}) => {
  return (
    <span
      className={cn(
        'inline-flex items-center font-medium rounded-full whitespace-nowrap',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
    >
      {children}
    </span>
  );
};
