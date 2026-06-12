/**
 * The storage modal's toolbar. Shows the default action row (upload / new
 * folder / set working dir) or, when items are selected, a bulk action bar
 * (download / delete / clear). The upload-progress bar renders below either.
 *
 * Presentational leaf: the hidden file <input> and all state stay in the modal;
 * this component only emits callbacks. Upload fields are bundled into one
 * `upload` object to keep the prop surface narrow.
 */

import { useTranslation } from 'react-i18next';
import { X, Upload, FolderPlus, Trash2, Download, FolderCog } from 'lucide-react';

export interface UploadState {
  isUploading: boolean;
  uploadProgress: number;
  uploadTotal: number;
  uploadCompleted: number;
}

export interface StorageToolbarProps {
  selectedCount: number;
  // Bulk actions (shown when selectedCount > 0)
  onBulkDownload: () => void;
  onBulkDelete: () => void;
  onClearSelection: () => void;
  // Default actions (shown when nothing is selected)
  canSetWorkingDirectory: boolean;
  onUploadClick: () => void;
  onNewFolder: () => void;
  onSetWorkingDirectory: () => void;
  upload: UploadState;
}

export function StorageToolbar({
  selectedCount,
  onBulkDownload,
  onBulkDelete,
  onClearSelection,
  canSetWorkingDirectory,
  onUploadClick,
  onNewFolder,
  onSetWorkingDirectory,
  upload,
}: StorageToolbarProps) {
  const { t } = useTranslation();
  const { isUploading, uploadProgress, uploadTotal, uploadCompleted } = upload;

  return (
    <div className="px-4 md:px-6 py-2.5 border-b border-border bg-surface-secondary">
      {selectedCount > 0 ? (
        /* Bulk action bar (shown when one or more items are selected) */
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-fg-default whitespace-nowrap">
              {t('storage.selectedCount', { count: selectedCount })}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onBulkDownload}
              className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('storage.bulkDownload')}</span>
            </button>
            <button
              onClick={onBulkDelete}
              className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-feedback-error hover:bg-feedback-error-bg rounded transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('storage.bulkDelete')}</span>
            </button>
            <button
              onClick={onClearSelection}
              className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors"
              title={t('storage.clearSelection')}
            >
              <X className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('storage.clearSelection')}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={onUploadClick}
            disabled={isUploading}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t('storage.upload')}</span>
          </button>

          <button
            onClick={onNewFolder}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span>{t('storage.newFolder')}</span>
          </button>

          <button
            onClick={onSetWorkingDirectory}
            disabled={!canSetWorkingDirectory}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <FolderCog className="w-3.5 h-3.5" />
            <span>{t('storage.setAsWorkingDirectory')}</span>
          </button>
        </div>
      )}

      {/* Upload progress */}
      {isUploading && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs sm:text-sm text-fg-secondary mb-1">
            <span className="truncate">
              {uploadTotal > 0
                ? t('storage.uploadingProgress', {
                    completed: uploadCompleted,
                    total: uploadTotal,
                  })
                : t('storage.uploading')}
            </span>
            <span className="ml-2">{uploadProgress}%</span>
          </div>
          <div className="w-full bg-border rounded-full h-2">
            <div
              className="bg-action-primary h-2 rounded-full transition-all duration-300"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
