import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle, Download } from 'lucide-react';
import { generateDownloadUrl } from '../api/storage';
import { logger } from '../utils/logger';

interface S3VideoProps {
  path: string;
  className?: string;
}

export const S3Video: React.FC<S3VideoProps> = ({ path, className = '' }) => {
  const { t } = useTranslation();
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPresignedUrl = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const url = await generateDownloadUrl(path);
        setPresignedUrl(url);
      } catch (err) {
        logger.error('Failed to generate presigned URL for video:', err);
        setError(err instanceof Error ? err.message : 'Failed to load video');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPresignedUrl();
  }, [path]);

  if (isLoading) {
    return (
      <div
        className={`flex items-center justify-center bg-surface-secondary rounded-lg ${className}`}
        style={{ minHeight: '300px' }}
      >
        <div className="text-center text-fg-muted">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
          <div className="text-sm">{t('storage.loadingVideo')}</div>
        </div>
      </div>
    );
  }

  if (error || !presignedUrl) {
    return (
      <div
        className={`flex items-center justify-center bg-feedback-error-bg border border-feedback-error-border rounded-lg ${className}`}
        style={{ minHeight: '200px' }}
      >
        <div className="text-center text-feedback-error">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
          <div className="text-sm">{t('storage.failedToLoadVideo')}</div>
          {error && <div className="text-xs mt-1 text-fg-secondary">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={`relative rounded-lg overflow-hidden bg-black ${className}`}>
      <video
        src={presignedUrl}
        controls
        className="w-full max-h-[600px]"
        onError={() => {
          logger.error('Video load error:', path);
          setError('Failed to display video');
        }}
        preload="metadata"
      >
        <track kind="captions" />
        {t('storage.videoNotSupported')}
      </video>

      {/* Download button */}
      <a
        href={presignedUrl}
        download
        className="absolute top-2 right-2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all"
        title={t('storage.download')}
      >
        <Download className="w-5 h-5" />
      </a>
    </div>
  );
};
