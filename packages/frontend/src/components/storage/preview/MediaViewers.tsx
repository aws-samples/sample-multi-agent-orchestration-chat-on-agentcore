import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileAudio } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { ViewerError, ViewerLoading } from './ViewerStates';

interface MediaViewerProps {
  url: string | null;
  urlError?: string | null;
  name: string;
  tone?: 'light' | 'dark';
  className?: string;
}

export function VideoViewer({ url, urlError, name, tone, className }: MediaViewerProps) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (urlError || failed) {
    return (
      <ViewerError message={t('storage.preview.mediaFailed')} tone={tone} className={className} />
    );
  }
  if (!url) return <ViewerLoading tone={tone} className={className} />;
  return (
    <div className={cn('flex h-full items-center justify-center', className)}>
      <video
        src={url}
        controls
        preload="metadata"
        aria-label={name}
        onError={() => setFailed(true)}
        className="max-h-full max-w-full rounded-lg bg-black"
      />
    </div>
  );
}

export function AudioViewer({ url, urlError, name, tone, className }: MediaViewerProps) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (urlError || failed) {
    return (
      <ViewerError message={t('storage.preview.mediaFailed')} tone={tone} className={className} />
    );
  }
  if (!url) return <ViewerLoading tone={tone} className={className} />;
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-6', className)}>
      <FileAudio className={cn('h-16 w-16', tone === 'dark' ? 'text-white/60' : 'text-teal-500')} />
      <audio
        src={url}
        controls
        preload="metadata"
        aria-label={name}
        onError={() => setFailed(true)}
        className="w-full max-w-md"
      />
    </div>
  );
}

/**
 * Browser-native PDF viewer. Not sandboxed: Chrome's viewer refuses to run in a
 * sandboxed frame, and the backend forces `application/pdf` on inline URLs so
 * nothing else can be rendered here.
 */
export function PdfViewer({ url, urlError, name, tone, className }: MediaViewerProps) {
  const { t } = useTranslation();
  if (urlError) {
    return (
      <ViewerError message={t('storage.preview.loadFailed')} tone={tone} className={className} />
    );
  }
  if (!url) return <ViewerLoading tone={tone} className={className} />;
  return (
    <div className={cn('relative h-full w-full', className)}>
      <iframe
        src={url}
        title={name}
        referrerPolicy="no-referrer"
        className="h-full w-full rounded-lg border-0 bg-white"
      />
      {/* Mobile browsers often show only the first page inside an iframe. */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full border border-border bg-surface-primary/95 px-3 py-1.5 text-xs text-fg-secondary shadow-elevation-2 hover:bg-surface-secondary"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {t('storage.preview.openInNewTab')}
      </a>
    </div>
  );
}
