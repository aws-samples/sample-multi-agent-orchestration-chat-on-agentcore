import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import type { StorageItem } from '../../../api/storage';
import { IconButton } from '../../ui/Button';
import { cn } from '../../../lib/utils';
import { getFileIcon } from '../../../utils/fileIcons';
import { formatBytes } from '../../../utils/formatBytes';
import type { PreviewNavigation } from './usePreviewNavigation';

export interface PreviewHeaderProps {
  item: StorageItem;
  /** Omit when there is no sibling list to step through. */
  nav?: PreviewNavigation;
  /** Replaces the size · date line (e.g. when only the path is known). */
  meta?: string;
  onDownload: (item: StorageItem) => void;
  /** Omit to hide the button (types the browser cannot show inline). */
  onOpenInNewTab?: (item: StorageItem) => void;
  onClose: () => void;
  tone?: 'light' | 'dark';
  /** Show prev/next buttons inline (layouts with side arrows hide them). */
  showNavButtons?: boolean;
  /** Omit to hide the toggle (e.g. mobile, where the preview is always full-screen). */
  fullscreen?: { active: boolean; onToggle: () => void };
  className?: string;
}

export function PreviewHeader({
  item,
  nav,
  meta: metaOverride,
  onDownload,
  onOpenInNewTab,
  onClose,
  tone = 'light',
  showNavButtons = false,
  fullscreen,
  className,
}: PreviewHeaderProps) {
  const { t, i18n } = useTranslation();
  const { icon: Icon = File, color } = getFileIcon(item.name);
  const dark = tone === 'dark';
  const btnClass = dark ? 'text-white/80 hover:text-white hover:bg-white/10' : undefined;

  const meta =
    metaOverride ??
    [
      formatBytes(item.size, { emptyPlaceholder: '—', maxUnit: 'GB' }),
      item.lastModified ? new Date(item.lastModified).toLocaleString(i18n.language) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className={cn('flex items-center gap-3 px-4 py-3', className)}>
      <Icon className={cn('h-5 w-5 shrink-0', color)} />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-medium', dark ? 'text-white' : 'text-fg-default')}>
          {item.name}
        </p>
        <p className={cn('truncate text-xs', dark ? 'text-white/60' : 'text-fg-muted')}>{meta}</p>
      </div>
      {nav && nav.total > 1 && nav.index >= 0 && (
        <span
          className={cn('shrink-0 text-xs tabular-nums', dark ? 'text-white/60' : 'text-fg-muted')}
        >
          {t('storage.preview.position', { current: nav.index + 1, total: nav.total })}
        </span>
      )}
      {nav && showNavButtons && (
        <>
          <IconButton
            icon={ChevronLeft}
            label={t('storage.preview.previous')}
            onClick={nav.prev}
            disabled={!nav.hasPrev}
            className={btnClass}
          />
          <IconButton
            icon={ChevronRight}
            label={t('storage.preview.next')}
            onClick={nav.next}
            disabled={!nav.hasNext}
            className={btnClass}
          />
        </>
      )}
      {fullscreen && (
        <IconButton
          icon={fullscreen.active ? Minimize2 : Maximize2}
          label={
            fullscreen.active
              ? t('storage.preview.exitFullscreen')
              : t('storage.preview.fullscreen')
          }
          onClick={fullscreen.onToggle}
          className={btnClass}
        />
      )}
      {onOpenInNewTab && (
        <IconButton
          icon={ExternalLink}
          label={t('storage.preview.openInNewTab')}
          onClick={() => onOpenInNewTab(item)}
          className={btnClass}
        />
      )}
      <IconButton
        icon={Download}
        label={t('storage.download')}
        onClick={() => onDownload(item)}
        className={btnClass}
      />
      <IconButton
        icon={X}
        label={t('storage.preview.close')}
        onClick={onClose}
        className={btnClass}
      />
    </div>
  );
}
