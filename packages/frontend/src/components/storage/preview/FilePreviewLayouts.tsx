/**
 * Storage file preview: a side pane inside the storage modal that switches to
 * a full-screen dark viewer (always full-screen on mobile).
 *
 * Full-screen is a CSS state of the same element (position: fixed), not a
 * second component: remounting the viewer would restart video playback, drop
 * image zoom and re-fetch the presigned URL / text on every toggle.
 */

import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { StorageItem } from '../../../api/storage';
import { cn } from '../../../lib/utils';
import { useUIStore } from '../../../stores/uiStore';
import { FilePreviewBody } from './FilePreviewBody';
import { PreviewHeader } from './PreviewHeader';
import type { PreviewNavigation } from './usePreviewNavigation';

export interface FilePreviewPanelProps {
  item: StorageItem;
  nav: PreviewNavigation;
  onDownload: (item: StorageItem) => void;
  onClose: () => void;
  isFullscreen: boolean;
  /** Omit to hide the toggle (mobile, where the panel is always full-screen). */
  onToggleFullscreen?: () => void;
  className?: string;
}

function SideArrows({ nav }: { nav: PreviewNavigation }) {
  const { t } = useTranslation();
  const cls =
    'absolute top-1/2 -translate-y-1/2 z-10 rounded-full p-2 transition-colors disabled:opacity-0 bg-white/10 text-white hover:bg-white/20';
  return (
    <>
      <button
        type="button"
        onClick={nav.prev}
        disabled={!nav.hasPrev}
        aria-label={t('storage.preview.previous')}
        className={cn(cls, 'left-3')}
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <button
        type="button"
        onClick={nav.next}
        disabled={!nav.hasNext}
        aria-label={t('storage.preview.next')}
        className={cn(cls, 'right-3')}
      >
        <ChevronRight className="h-6 w-6" />
      </button>
    </>
  );
}

export function FilePreviewPanel({
  item,
  nav,
  onDownload,
  onClose,
  isFullscreen,
  onToggleFullscreen,
  className,
}: FilePreviewPanelProps) {
  // Mobile: side arrows would cover the content, so prev/next stay in the header
  // and the body uses (almost) the full width.
  const isMobileView = useUIStore((s) => s.isMobileView);
  const tone = isFullscreen ? 'dark' : 'light';
  return (
    <section
      data-file-preview=""
      role={isFullscreen ? 'dialog' : 'region'}
      aria-modal={isFullscreen || undefined}
      aria-label={item.name}
      className={cn(
        'flex min-w-0 flex-col',
        isFullscreen ? 'fixed inset-0 z-[60] bg-black/90 backdrop-blur-sm' : 'bg-surface-primary',
        className
      )}
    >
      <PreviewHeader
        item={item}
        nav={nav}
        onDownload={onDownload}
        onClose={onClose}
        fullscreen={
          onToggleFullscreen ? { active: isFullscreen, onToggle: onToggleFullscreen } : undefined
        }
        tone={tone}
        showNavButtons={!isFullscreen || isMobileView}
        className={
          isFullscreen ? 'bg-gradient-to-b from-black/60 to-transparent' : 'border-b border-border'
        }
      />
      <div className={cn('relative min-h-0 flex-1', !isFullscreen && 'bg-surface-secondary')}>
        {isFullscreen && !isMobileView && <SideArrows nav={nav} />}
        <FilePreviewBody
          item={item}
          onDownload={onDownload}
          tone={tone}
          className={!isFullscreen ? 'p-3' : isMobileView ? 'px-2 pb-2' : 'px-16 pb-8'}
        />
      </div>
    </section>
  );
}
