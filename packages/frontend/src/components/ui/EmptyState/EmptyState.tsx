/**
 * EmptyState Atom Component
 * Placeholder for pages/sections with no content.
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface EmptyStateProps {
  /** Icon to display */
  icon: LucideIcon;
  /** Title text */
  title: string;
  /** Description text */
  description?: string;
  /** Optional action element (e.g., a button) */
  action?: React.ReactNode;
  /** Additional class names */
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className,
}) => {
  return (
    <div className={cn('text-center py-12', className)}>
      <Icon className="w-12 h-12 text-fg-disabled mx-auto mb-4" />
      <h3 className="text-sm font-medium text-fg-secondary mb-2">{title}</h3>
      {description && <p className="text-fg-muted text-sm mb-4">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
};
