/**
 * General-purpose loading indicator component
 * Provides consistent loading display throughout the application
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

export interface LoadingIndicatorProps {
  /** Loading message */
  message?: string;
  /** Spinner size */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to center-align */
  center?: boolean;
  /** Outer margin */
  spacing?: 'none' | 'sm' | 'md' | 'lg';
  /** Custom text color */
  textColor?: string;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  message,
  size = 'md',
  center = true,
  spacing = 'md',
  textColor = 'text-fg-muted',
}) => {
  const { t } = useTranslation();
  const displayMessage = message ?? t('common.loading');

  // Spinner size definitions
  const spinnerSizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-6 h-6',
  };

  // Outer margin definition
  const spacingClasses = {
    none: '',
    sm: 'py-2',
    md: 'py-4',
    lg: 'py-8',
  };

  const containerClasses = [center ? 'text-center' : '', spacingClasses[spacing]]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClasses}>
      <div className={`inline-flex items-center gap-2 text-sm ${textColor}`}>
        <div
          className={`${spinnerSizeClasses[size]} border-2 border-border-strong border-t-fg-secondary rounded-full animate-spin`}
        />
        {displayMessage}
      </div>
    </div>
  );
};
