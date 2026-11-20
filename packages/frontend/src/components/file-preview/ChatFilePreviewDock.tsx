// Narrows the chat instead of floating over it so the conversation stays
// readable next to the file; mobile has no room for both, hence the sheet.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight, X } from 'lucide-react';
import type { StorageItem } from '../../api/storage';
import { cn } from '../../lib/utils';
import { useFilePreviewStore } from '../../stores/filePreviewStore';
import { useFilePreviewAvailable } from '../../hooks/useFilePreviewAvailable';
import { useUIStore } from '../../stores/uiStore';
import { IconButton } from '../ui/Button';
import { FilePreviewBody } from '../storage/preview/FilePreviewBody';
import { PreviewHeader } from '../storage/preview/PreviewHeader';
import { canOpenInNewTab, downloadFile, openFileInNewTab } from '../../api/storageFileActions';
import { useResizablePane } from '../storage/preview/useResizablePane';
import { storageBasename, storageDirname } from '../../utils/storagePath';

const MIN_CHAT_PX = 420;
const PANE_OPTIONS = {
  storageKey: 'moca.chat.previewDockRatio',
  defaultRatio: 0.45,
  minListPx: MIN_CHAT_PX,
  minPanePx: 360,
  reservedPx: MIN_CHAT_PX,
};

function toItem(path: string): StorageItem {
  return { name: storageBasename(path), path, type: 'file' };
}

const download = (item: StorageItem) => downloadFile(item.path);
const openInNewTab = (item: StorageItem) => openFileInNewTab(item.path);

interface ChatFilePreviewDockProps {
  /** The chat column left of the dock; its parent is the row being split. */
  chatColumnRef: React.RefObject<HTMLElement | null>;
}

export function ChatFilePreviewDock({ chatColumnRef }: ChatFilePreviewDockProps) {
  const { t } = useTranslation();
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const path = useFilePreviewStore((s) => s.path);
  const close = useFilePreviewStore((s) => s.close);
  const openFile = useFilePreviewStore((s) => s.open);
  const isMobileView = useUIStore((s) => s.isMobileView);
  const available = useFilePreviewAvailable();
  const emptyRequested = useFilePreviewStore((s) => s.emptyRequested);
  const pane = useResizablePane(chatColumnRef, PANE_OPTIONS);
  const item = useMemo(() => (path ? toItem(path) : null), [path]);

  if (!isOpen || !(path || (emptyRequested && available))) return null;

  return (
    <aside
      aria-label={t('chat.filePreview.title')}
      className={cn(
        'flex flex-col bg-surface-primary',
        isMobileView ? 'fixed inset-0 z-50' : 'relative h-dvh shrink-0 border-l border-border'
      )}
      style={isMobileView ? undefined : pane.paneStyle}
    >
      {!isMobileView && (
        /* Straddles the dock's left border. */
        <div
          {...pane.handleProps}
          aria-label={t('storage.preview.resizePane')}
          title={t('storage.preview.resizePane')}
          className={cn(
            'absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none',
            'after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors',
            'hover:after:bg-action-primary/50 focus-visible:outline-hidden focus-visible:after:bg-action-primary/50',
            pane.isResizing && 'after:bg-action-primary/50'
          )}
        />
      )}
      {item ? (
        <>
          <PreviewHeader
            item={item}
            meta={storageDirname(item.path)}
            onDownload={download}
            onOpenInNewTab={canOpenInNewTab(item.name) ? openInNewTab : undefined}
            onClose={close}
            className="border-b border-border"
          />
          {/* PDF iframes would swallow pointer events mid-drag. */}
          <div
            className={cn(
              'relative min-h-0 flex-1 bg-surface-subtle',
              pane.isResizing && 'pointer-events-none'
            )}
          >
            <FilePreviewBody
              item={item}
              onDownload={download}
              onOpenFile={openFile}
              className="p-3"
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <p className="flex-1 truncate text-sm font-medium text-fg-default">
              {t('chat.filePreview.title')}
            </p>
            <IconButton icon={X} label={t('storage.preview.close')} onClick={close} />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-subtle p-6 text-center">
            <PanelRight className="h-8 w-8 text-fg-disabled" aria-hidden />
            <p className="text-sm text-fg-secondary">{t('chat.filePreview.empty')}</p>
          </div>
        </>
      )}
    </aside>
  );
}
