import { useTranslation } from 'react-i18next';
import { Download, File } from 'lucide-react';
import type { StorageItem } from '../../../api/storage';
import { Button } from '../../ui/Button';
import { cn } from '../../../lib/utils';
import { getFileIcon } from '../../../utils/fileIcons';
import { formatBytes } from '../../../utils/formatBytes';
import { getFileExtension, getPreviewInfo, type PreviewInfo } from '../../../utils/filePreview';
import { ImageViewer } from './ImageViewer';
import { AudioViewer, PdfViewer, VideoViewer } from './MediaViewers';
import { CodeViewer, CsvViewer, MarkdownViewer } from './TextViewers';
import { useFilePreviewUrl } from './useFilePreviewUrl';
import { useFileText } from './useFileText';
import { ViewerError, ViewerLoading } from './ViewerStates';

export interface FilePreviewBodyProps {
  item: StorageItem;
  onDownload: (item: StorageItem) => void;
  tone?: 'light' | 'dark';
  className?: string;
}

// Native browser viewers need the backend's inline Content-Type/-Disposition.
const INLINE_KINDS = new Set<PreviewInfo['kind']>(['pdf', 'video', 'audio']);

/** Picks the viewer for `item`; unsupported types get the file-info card. */
export function FilePreviewBody({
  item,
  onDownload,
  tone = 'light',
  className,
}: FilePreviewBodyProps) {
  const info = getPreviewInfo(item.name);
  const { url, error } = useFilePreviewUrl(
    info.kind === 'unsupported' ? null : item.path,
    INLINE_KINDS.has(info.kind)
  );
  const viewerProps = { url, urlError: error, name: item.name, tone, className };

  switch (info.kind) {
    case 'image':
      return (
        <ImageViewer
          key={item.path}
          url={url}
          urlError={error}
          alt={item.name}
          tone={tone}
          className={className}
        />
      );
    case 'video':
      return <VideoViewer key={item.path} {...viewerProps} />;
    case 'audio':
      return <AudioViewer key={item.path} {...viewerProps} />;
    case 'pdf':
      return <PdfViewer key={item.path} {...viewerProps} />;
    case 'unsupported':
      return <FileInfoCard item={item} onDownload={onDownload} tone={tone} className={className} />;
    default:
      // code / text / markdown / csv
      return (
        <TextFileBody
          key={item.path}
          item={item}
          info={info}
          url={url}
          urlError={error}
          tone={tone}
          className={className}
        />
      );
  }
}

function TextFileBody({
  item,
  info,
  url,
  urlError,
  tone,
  className,
}: {
  item: StorageItem;
  info: PreviewInfo;
  url: string | null;
  urlError: string | null;
  tone: 'light' | 'dark';
  className?: string;
}) {
  const { t } = useTranslation();
  const { text, truncated, error } = useFileText(url, item.size);

  if (urlError || error) {
    return (
      <ViewerError message={t('storage.preview.loadFailed')} tone={tone} className={className} />
    );
  }
  if (text === null) return <ViewerLoading tone={tone} className={className} />;

  const content = { text, truncated, className };
  if (info.kind === 'markdown') return <MarkdownViewer {...content} path={item.path} />;
  if (info.kind === 'csv') return <CsvViewer {...content} delimiter={info.delimiter ?? ','} />;
  return <CodeViewer {...content} language={info.language} />;
}

function FileInfoCard({ item, onDownload, tone, className }: FilePreviewBodyProps) {
  const { t, i18n } = useTranslation();
  const { icon: Icon = File, color } = getFileIcon(item.name);
  const ext = getFileExtension(item.name);
  const dark = tone === 'dark';

  const rows: Array<[string, string]> = [
    [t('storage.type'), ext ? ext.toUpperCase() : '—'],
    [t('storage.size'), formatBytes(item.size, { emptyPlaceholder: '—', maxUnit: 'GB' })],
    [
      t('storage.lastModified'),
      item.lastModified ? new Date(item.lastModified).toLocaleString(i18n.language) : '—',
    ],
  ];

  return (
    <div className={cn('flex h-full items-center justify-center p-6', className)}>
      <div
        className={cn(
          'w-full max-w-sm rounded-2xl border p-6 text-center',
          dark ? 'border-white/15 bg-white/5 text-white' : 'border-border bg-surface-primary'
        )}
      >
        <Icon className={cn('mx-auto mb-3 h-12 w-12', color)} />
        <p className={cn('break-all text-sm font-medium', dark ? 'text-white' : 'text-fg-default')}>
          {item.name}
        </p>
        <p className={cn('mt-1 text-xs', dark ? 'text-white/60' : 'text-fg-muted')}>
          {t('storage.preview.notSupported')}
        </p>
        <dl className="mt-4 space-y-1.5 text-left text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className={dark ? 'text-white/60' : 'text-fg-muted'}>{label}</dt>
              <dd className={cn('font-mono', dark ? 'text-white/90' : 'text-fg-secondary')}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <Button className="mt-5 w-full" leftIcon={Download} onClick={() => onDownload(item)}>
          {t('storage.download')}
        </Button>
      </div>
    </div>
  );
}
