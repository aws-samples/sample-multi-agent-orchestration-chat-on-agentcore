/**
 * Error Boundary Component
 * Catches React errors and displays fallback UI
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { withTranslation } from 'react-i18next';
import type { WithTranslation } from 'react-i18next';
import { logger } from '../utils/logger';

interface Props extends WithTranslation {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundaryInner extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logger.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({
      errorInfo,
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { t } = this.props;

    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-surface-secondary flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-surface-primary rounded-card shadow-elevation-4 p-6">
            <div className="flex items-center justify-center w-12 h-12 mx-auto bg-feedback-error-bg rounded-full mb-4">
              <AlertTriangle className="w-6 h-6 text-feedback-error" />
            </div>

            <h1 className="text-xl font-semibold text-fg-default text-center mb-2">
              {t('error.boundary.title')}
            </h1>

            <p className="text-fg-secondary text-center mb-6">{t('error.boundary.description')}</p>

            {this.state.error && (
              <div className="bg-surface-secondary rounded-card p-4 mb-6">
                <p className="text-sm font-mono text-fg-secondary break-all">
                  {this.state.error.message}
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={this.handleReload}
                className="flex-1 px-4 py-2 bg-action-primary text-action-primary-fg rounded-btn hover:bg-action-primary-hover transition-colors"
              >
                {t('error.boundary.reload')}
              </button>

              <button
                onClick={() => (window.location.href = '/')}
                className="flex-1 px-4 py-2 bg-surface-secondary text-fg-secondary rounded-btn hover:bg-border transition-colors"
              >
                {t('error.boundary.backToHome')}
              </button>
            </div>

            {import.meta.env.DEV && this.state.errorInfo && (
              <details className="mt-6">
                <summary className="text-sm text-fg-secondary cursor-pointer hover:text-fg-default">
                  {t('error.boundary.developerInfo')}
                </summary>
                <pre className="mt-2 text-xs bg-surface-secondary rounded p-3 overflow-auto max-h-64">
                  {this.state.errorInfo.componentStack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryInner);
