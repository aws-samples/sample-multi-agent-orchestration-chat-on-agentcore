import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle } from 'lucide-react';
import { generateDownloadUrl } from '../api/storage';
import { logger } from '../utils/logger';

interface S3ImageProps {
  path: string;
  alt: string;
  className?: string;
}

export const S3Image: React.FC<S3ImageProps> = ({ path, alt, className = '' }) => {
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
        logger.error('Failed to generate presigned URL for image:', err);
        setError(err instanceof Error ? err.message : 'Failed to load image');
      } finally {
        setIsLoading(false);
      }
    };

    fetchPresignedUrl();
  }, [path]);

  if (isLoading) {
    return (
      <div
        className={`flex items-center justify-center bg-surface-secondary rounded ${className}`}
        style={{ minHeight: '200px' }}
      >
        <div className="text-center text-fg-muted">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
          <div className="text-sm">{t('storage.loadingImage')}</div>
        </div>
      </div>
    );
  }

  if (error || !presignedUrl) {
    return (
      <div
        className={`flex items-center justify-center bg-feedback-error-bg border border-feedback-error-border rounded ${className}`}
        style={{ minHeight: '150px' }}
      >
        <div className="text-center text-feedback-error">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
          <div className="text-sm">{t('storage.failedToLoadImage')}</div>
          {error && <div className="text-xs mt-1 text-fg-secondary">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <img
      src={presignedUrl}
      alt={alt}
      className={className}
      onError={() => {
        logger.error('Image load error:', path);
        setError('Failed to display image');
      }}
    />
  );
};
