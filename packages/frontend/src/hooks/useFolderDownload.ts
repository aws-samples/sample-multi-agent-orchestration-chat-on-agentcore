/**
 * Download orchestration for the storage modal: single-file downloads, folder
 * and bulk ZIP downloads, progress/cancel, and the partial-failure warning —
 * all behind one narrow surface.
 *
 * The hook owns its own state cluster (progress modal, status, error/warning,
 * abort controller) and returns `modalProps` that spread straight onto
 * <DownloadProgressModal/>, plus three action callbacks. It takes `t` as an
 * argument (the modal already holds it) rather than calling useTranslation, so
 * the only i18n keys it touches are explicit.
 */

import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import {
  generateDownloadUrl,
  downloadFolder,
  downloadItems,
  type DownloadProgress,
  type StorageItem,
} from '../api/storage';
import { downloadWithAsyncUrl } from '../utils/download';
import { logger } from '../utils/logger';

type DownloadStatus = 'downloading' | 'success' | 'error' | 'cancelled';

const ZERO_PROGRESS: DownloadProgress = { current: 0, total: 0, percentage: 0, currentFile: '' };

export interface UseFolderDownload {
  /** Spread directly onto <DownloadProgressModal {...modalProps} />. */
  modalProps: {
    isOpen: boolean;
    onClose: () => void;
    progress: DownloadProgress;
    status: DownloadStatus;
    errorMessage: string;
    warningMessage: string;
    onCancel: (() => void) | undefined;
  };
  /** Download a single item: file → presigned URL popup; directory → ZIP. */
  downloadItem: (item: StorageItem) => Promise<void>;
  /** Download a folder path as a ZIP, showing the progress modal. */
  downloadFolderAsZip: (folderPath: string, folderName: string) => Promise<void>;
  /**
   * Bulk-download a selection as one ZIP. A lone file bypasses ZIP wrapping.
   * `onComplete` runs only on success (the modal passes clearSelection).
   */
  downloadSelection: (items: StorageItem[], onComplete?: () => void) => Promise<void>;
}

export function useFolderDownload(t: TFunction): UseFolderDownload {
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress>(ZERO_PROGRESS);
  const [status, setStatus] = useState<DownloadStatus>('downloading');
  const [errorMessage, setErrorMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // Map a thrown value to a terminal status. The 'Download cancelled' sentinel
  // is thrown by the API layer on abort and must be matched verbatim.
  const applyError = useCallback((error: unknown) => {
    if (error instanceof Error && error.message === 'Download cancelled') {
      setStatus('cancelled');
      return;
    }
    setStatus('error');
    setErrorMessage(error instanceof Error ? error.message : 'Unknown error occurred');
  }, []);

  // Open the modal and reset all transient state for a fresh ZIP download.
  const beginZipDownload = useCallback(() => {
    setStatus('downloading');
    setErrorMessage('');
    setWarningMessage('');
    setProgress(ZERO_PROGRESS);
    setIsDownloadModalOpen(true);
    abortControllerRef.current = new AbortController();
    return abortControllerRef.current.signal;
  }, []);

  const warnIfPartial = useCallback(
    (result: { failed: number; total: number }) => {
      if (result.failed > 0) {
        setWarningMessage(
          t('storage.downloadProgress.partialWarning', {
            failed: result.failed,
            total: result.total,
          })
        );
      }
    },
    [t]
  );

  const downloadFolderAsZip = useCallback(
    async (folderPath: string, folderName: string) => {
      const signal = beginZipDownload();
      try {
        const result = await downloadFolder(folderPath, folderName, setProgress, signal);
        warnIfPartial(result);
        setStatus('success');
      } catch (error) {
        applyError(error);
      } finally {
        abortControllerRef.current = null;
      }
    },
    [applyError, beginZipDownload, warnIfPartial]
  );

  const downloadItem = useCallback(
    async (item: StorageItem) => {
      if (item.type === 'directory') {
        await downloadFolderAsZip(item.path, item.name);
        return;
      }
      // File: open the download synchronously within the user gesture (before
      // any await) so mobile browsers keep transient activation.
      await downloadWithAsyncUrl(
        () => generateDownloadUrl(item.path),
        (error) => logger.error('Download error:', error)
      );
    },
    [downloadFolderAsZip]
  );

  const downloadSelection = useCallback(
    async (items: StorageItem[], onComplete?: () => void) => {
      if (items.length === 0) return;

      // A single selected file downloads directly (no ZIP), still completing.
      if (items.length === 1 && items[0].type === 'file') {
        await downloadItem(items[0]);
        onComplete?.();
        return;
      }

      const signal = beginZipDownload();
      try {
        const result = await downloadItems(items, t('storage.bulkDownloadName'), setProgress, signal);
        warnIfPartial(result);
        setStatus('success');
        onComplete?.();
      } catch (error) {
        applyError(error);
      } finally {
        abortControllerRef.current = null;
      }
    },
    [applyError, beginZipDownload, downloadItem, t, warnIfPartial]
  );

  const onCancel = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const onClose = useCallback(() => {
    setIsDownloadModalOpen(false);
    setProgress(ZERO_PROGRESS);
    setErrorMessage('');
    setWarningMessage('');
  }, []);

  return {
    modalProps: {
      isOpen: isDownloadModalOpen,
      onClose,
      progress,
      status,
      errorMessage,
      warningMessage,
      onCancel: status === 'downloading' ? onCancel : undefined,
    },
    downloadItem,
    downloadFolderAsZip,
    downloadSelection,
  };
}
