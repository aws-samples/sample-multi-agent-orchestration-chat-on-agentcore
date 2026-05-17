/**
 * Download Progress Modal
 * Modal for displaying folder download progress
 */

import React from 'react';
import { X, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Modal } from './Modal/Modal';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Alert } from './Alert';

interface DownloadProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  progress: {
    current: number;
    total: number;
    percentage: number;
    currentFile: string;
  };
  status: 'downloading' | 'success' | 'error' | 'cancelled';
  errorMessage?: string;
  onCancel?: () => void;
}

export const DownloadProgressModal: React.FC<DownloadProgressModalProps> = ({
  isOpen,
  onClose,
  progress,
  status,
  errorMessage,
  onCancel,
}) => {
  const { t } = useTranslation();

  const canClose = status === 'success' || status === 'error' || status === 'cancelled';

  return (
    <Modal isOpen={isOpen} onClose={canClose ? onClose : () => {}}>
      <div className="w-full max-w-md min-w-[400px]">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            {status === 'downloading' && (
              <Loader2 className="w-5 h-5 text-action-primary animate-spin" />
            )}
            {status === 'success' && <CheckCircle className="w-5 h-5 text-action-success" />}
            {status === 'error' && <XCircle className="w-5 h-5 text-feedback-error" />}
            {status === 'cancelled' && <XCircle className="w-5 h-5 text-fg-secondary" />}
            <h2 className="text-xl font-semibold text-fg-default">
              {status === 'downloading' && t('storage.downloadProgress.downloading')}
              {status === 'success' && t('storage.downloadProgress.success')}
              {status === 'error' && t('storage.downloadProgress.error')}
              {status === 'cancelled' && t('storage.downloadProgress.cancelled')}
            </h2>
          </div>
          {canClose && (
            <button
              onClick={onClose}
              className="p-2 text-fg-disabled hover:text-fg-secondary hover:bg-surface-secondary rounded-btn transition-colors"
              aria-label={t('common.close')}
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 min-h-[200px]">
          {/* Progress Bar */}
          {(status === 'downloading' || status === 'success') && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-fg-secondary">
                <span>
                  {progress.current} / {progress.total} {t('storage.downloadProgress.files')}
                </span>
                <span>{progress.percentage}%</span>
              </div>
              <div className="w-full bg-border rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    status === 'success' ? 'bg-action-success' : 'bg-action-primary'
                  }`}
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
            </div>
          )}

          {/* Current File */}
          {status === 'downloading' && (
            <div className="space-y-1 min-h-[52px]">
              <p className="text-sm text-fg-muted">{t('storage.downloadProgress.currentFile')}</p>
              <p
                className="text-sm text-fg-default font-mono truncate max-w-full overflow-hidden"
                title={progress.currentFile}
              >
                {progress.currentFile}
              </p>
            </div>
          )}

          {/* Success Message */}
          {status === 'success' && (
            <div className="text-sm text-fg-secondary">
              <p>{t('storage.downloadProgress.successMessage')}</p>
            </div>
          )}

          {/* Error Message */}
          {status === 'error' && errorMessage && <Alert variant="error">{errorMessage}</Alert>}

          {/* Cancelled Message */}
          {status === 'cancelled' && (
            <div className="text-sm text-fg-secondary">
              <p>{t('storage.downloadProgress.cancelledMessage')}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-6 border-t border-border">
          {status === 'downloading' && onCancel && (
            <Button variant="outline" size="md" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          )}
          {canClose && (
            <Button variant="primary" size="md" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};
