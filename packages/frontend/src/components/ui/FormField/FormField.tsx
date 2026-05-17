/**
 * FormField Molecule Component
 * Wraps form inputs with label, description, error message, and required indicator.
 */

import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface FormFieldProps {
  /** Field label */
  label: string;
  /** HTML for attribute (links label to input) */
  htmlFor?: string;
  /** Error message */
  error?: string;
  /** Description text */
  description?: string;
  /** Show required indicator */
  required?: boolean;
  /** Field content (input, textarea, etc.) */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  htmlFor,
  error,
  description,
  required = false,
  children,
  className,
}) => {
  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg-secondary">
        {label}
        {required && <span className="text-feedback-error ml-0.5">*</span>}
      </label>
      {description && <p className="text-sm text-fg-muted">{description}</p>}
      {children}
      {error && (
        <div className="flex items-center gap-1.5 mt-1">
          <AlertCircle className="w-4 h-4 text-feedback-error flex-shrink-0" />
          <span className="text-sm text-feedback-error">{error}</span>
        </div>
      )}
    </div>
  );
};
