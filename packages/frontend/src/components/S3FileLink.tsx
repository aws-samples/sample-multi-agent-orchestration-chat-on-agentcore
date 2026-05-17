import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { generateDownloadUrl } from '../api/storage';
import { downloadWithAsyncUrl } from '../utils/download';
import { logger } from '../utils/logger';

interface S3FileLinkProps {
  path: string;
  children: React.ReactNode;
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

export const S3FileLink: React.FC<S3FileLinkProps> = ({ path, children }) => {
  const { t } = useTranslation();
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pre-fetch presigned URL on mount + refresh periodically before expiry.
  //
  // Inlined as an async IIFE (rather than a useCallback called from the
  // effect) so the loading-state mutation happens inside a Promise resolution
  // — not synchronously in the effect body — satisfying
  // react-hooks/set-state-in-effect.
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      setIsLoading(true);
      try {
        const url = await generateDownloadUrl(path);
        if (cancelled) return;
        setPresignedUrl(url);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to generate download URL:', err);
        setError(err instanceof Error ? err.message : 'Failed to generate download URL');
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
  }, [path]);

  // Fallback handler for when presigned URL is not yet available
  const handleFallbackClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    downloadWithAsyncUrl(
      () => generateDownloadUrl(path),
      (err) => {
        logger.error('Failed to generate download URL:', err);
        setError(err.message);
      }
    ).then((url) => {
      if (url) setPresignedUrl(url);
    });
  };

  // Extract filename from path
  const fileName = path.split('/').pop() || path;

  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={presignedUrl || path}
        onClick={presignedUrl ? undefined : handleFallbackClick}
        target="_blank"
        rel="noopener noreferrer"
        className={`
          inline-flex items-center gap-1
          text-action-primary hover:text-action-primary
          underline decoration-blue-300 hover:decoration-blue-500
          transition-colors cursor-pointer
          ${isLoading ? 'opacity-50 cursor-wait' : ''}
          ${error ? 'text-feedback-error' : ''}
        `}
        title={error || (isLoading ? 'Loading...' : `Download: ${fileName}`)}
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
