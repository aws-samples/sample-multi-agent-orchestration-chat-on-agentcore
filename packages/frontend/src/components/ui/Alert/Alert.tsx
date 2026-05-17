/**
 * Alert Atom Component
 * Feedback message component for errors, warnings, info, and success states.
 */

import React from 'react';
import { AlertCircle, CheckCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface AlertProps {
  /** Alert variant */
  variant: 'error' | 'warning' | 'info' | 'success';
  /** Optional title */
  title?: string;
  /** Alert content */
  children: React.ReactNode;
  /** Dismiss callback */
  onDismiss?: () => void;
  /** Additional class names */
  className?: string;
}

const variantStyles: Record<AlertProps['variant'], string> = {
  error: 'bg-feedback-error-bg border-feedback-error-border text-feedback-error',
  warning: 'bg-feedback-warning-bg border-feedback-warning-border text-feedback-warning',
  info: 'bg-feedback-info-bg border-feedback-info-border text-feedback-info',
  success: 'bg-feedback-success-bg border-feedback-success-border text-feedback-success',
};

const variantIcons: Record<AlertProps['variant'], React.FC<{ className?: string }>> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
};

export const Alert: React.FC<AlertProps> = ({ variant, title, children, onDismiss, className }) => {
  const Icon = variantIcons[variant];

  return (
    <div className={cn('border rounded-card p-4', variantStyles[variant], className)} role="alert">
      <div className="flex items-start gap-3">
        <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          {title && <h3 className="text-sm font-medium mb-1">{title}</h3>}
          <div className="text-sm opacity-90">{children}</div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="flex-shrink-0 p-0.5 rounded hover:bg-black/5 transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
