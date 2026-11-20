import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { generateDownloadUrl } from '../api/storage';
import { downloadWithAsyncUrl } from '../utils/download';
import { logger } from '../utils/logger';
import { canOpenInNewTab } from '../api/storageFileActions';
import { storageBasename } from '../utils/storagePath';
import { useFilePreviewStore } from '../stores/filePreviewStore';

interface S3FileLinkProps {
  path: string;
  children: React.ReactNode;
  /**
   * Opens the file in-app instead of a new tab. Modifier/middle clicks still
   * follow the href so "open in new tab" keeps working.
   */
  onOpen?: (path: string) => void;
}

// Presigned URL refresh interval (45 min — URLs typically expire in 1 hour)
const PRESIGNED_URL_REFRESH_INTERVAL = 45 * 60 * 1000;

function getFileIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'pdf':
      return '📄';
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'svg':
    case 'webp':
      return '🖼️';
    case 'doc':
    case 'docx':
      return '📝';
    case 'xls':
    case 'xlsx':
      return '📊';
    case 'zip':
    case 'tar':
    case 'gz':
      return '📦';
    case 'mp4':
    case 'mov':
    case 'avi':
      return '🎬';
    case 'mp3':
    case 'wav':
      return '🎵';
    case 'txt':
    case 'md':
      return '📃';
    default:
      return '📎';
  }
}

export const S3FileLink: React.FC<S3FileLinkProps> = ({ path, children, onOpen }) => {
  const { t } = useTranslation();
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  // In-app links rarely use the URL (only modifier clicks), so fetching one
  // per link on render and every 45 min would be mostly wasted requests.
  const prefetch = !onOpen;
  const [isLoading, setIsLoading] = useState(prefetch);
  const [error, setError] = useState<string | null>(null);
  const fileName = storageBasename(path);
  // The link opens in a new tab, so viewable types get an inline URL; the
  // rest (zip, docx…) keep the attachment URL and download.
  const inline = canOpenInNewTab(fileName);

  const registerLink = useFilePreviewStore((s) => s.registerLink);
  const opensInApp = !!onOpen;
  useEffect(() => (opensInApp ? registerLink() : undefined), [opensInApp, registerLink]);

  // Pre-fetch presigned URL on mount + refresh periodically before expiry.
  //
  // Inlined as an async IIFE (rather than a useCallback called from the
  // effect) so the loading-state mutation happens inside a Promise resolution
  // — not synchronously in the effect body — satisfying
  // react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!prefetch) return;
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      setIsLoading(true);
      try {
        const url = await generateDownloadUrl(path, { inline });
        if (cancelled) return;
        setPresignedUrl(url);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to generate download URL:', err);
        setError(err instanceof Error ? err.message : t('storage.downloadUrlFailed'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    run();
    const interval = setInterval(run, PRESIGNED_URL_REFRESH_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [path, inline, prefetch, t]);

  // Fallback handler for when presigned URL is not yet available
  const handleFallbackClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    downloadWithAsyncUrl(
      () => generateDownloadUrl(path, { inline }),
      (err) => {
        logger.error('Failed to generate download URL:', err);
        setError(err.message);
      }
    ).then((url) => {
      if (url) setPresignedUrl(url);
    });
  };

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onOpen && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
      onOpen(path);
      return;
    }
    if (!presignedUrl) handleFallbackClick(e);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={presignedUrl || path}
        onClick={handleClick}
        // Middle click skips onClick; without a fetched URL the href is the
        // bare storage path, which would open an app route.
        onAuxClick={(e) => {
          if (e.button === 1 && !presignedUrl) handleFallbackClick(e);
        }}
        target="_blank"
        rel="noopener noreferrer"
        className={`
          inline-flex items-center gap-1
          text-fg-link hover:text-fg-link
          underline decoration-blue-300 hover:decoration-blue-500
          transition-colors cursor-pointer
          ${isLoading ? 'opacity-50 cursor-wait' : ''}
          ${error ? 'text-feedback-error' : ''}
        `}
        title={
          error ||
          (onOpen
            ? t('chat.filePreview.openTooltip', { fileName })
            : isLoading
              ? t('common.loading')
              : inline
                ? t('chat.filePreview.newTabTooltip', { fileName })
                : t('storage.downloadTooltip', { fileName }))
        }
      >
        <span className="text-base leading-none">{getFileIcon(fileName)}</span>
        <span>{children}</span>
        {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
      </a>
      {error && (
        <span className="text-xs text-feedback-error ml-1">({t('storage.failedToLoad')})</span>
      )}
    </span>
  );
};
