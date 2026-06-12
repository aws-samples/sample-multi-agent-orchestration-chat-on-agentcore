/**
 * Right-click context menus for the storage modal.
 *
 * The content-panel menu and the folder-tree menu were ~90% duplicated JSX.
 * This collapses them into one presentational primitive ({@link StorageContextMenu})
 * driven by an `items[]` array, plus two thin wrappers that build the right
 * items for each surface. The menus are pure leaves: they receive data +
 * callbacks and never touch the store. Each menu self-dismisses on an outside
 * mousedown (matching the modal's previous behavior); the parent owns the
 * open/position state and `copiedPath`.
 */

import { useEffect, useRef, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Trash2, Copy, Check, FolderCog, type LucideIcon } from 'lucide-react';

export interface StorageContextMenuItem {
  key: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  /** Render a divider above this item. */
  dividerBefore?: boolean;
  /** Green "confirmation" styling (used by the Copy-path → Copied swap). */
  confirmActive?: boolean;
}

export interface StorageContextMenuProps {
  /** Viewport coordinates from the originating contextmenu event. */
  x: number;
  y: number;
  items: StorageContextMenuItem[];
  /** Outside-click dismissal; the parent clears its menu-position state. */
  onClose: () => void;
}

/** Generic positioned popover menu. Clamps to the viewport like the original. */
export function StorageContextMenu({ x, y, items, onClose }: StorageContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-50 min-w-[160px]"
      style={{
        left: `${Math.min(x, window.innerWidth - 180)}px`,
        top: `${Math.min(y, window.innerHeight - 200)}px`,
      }}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Fragment key={item.key}>
            {item.dividerBefore && <div className="border-t border-border my-1" />}
            <button
              onClick={item.onClick}
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              <Icon className={`w-4 h-4 ${item.confirmActive ? 'text-green-600' : 'text-fg-secondary'}`} />
              <span className={item.confirmActive ? 'text-green-600' : 'text-fg-default'}>
                {item.label}
              </span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

export interface ContentMenuState {
  x: number;
  y: number;
  path: string;
  type: 'file' | 'directory';
}

export interface StorageContentContextMenuProps {
  menu: ContentMenuState;
  copiedPath: string | null;
  onClose: () => void;
  onDownloadFile: () => void;
  onDownloadFolder: () => void;
  onSetWorkingDirectory: (path: string) => void;
  onDelete: () => void;
  onCopyPath: (path: string, closeMenu: () => void) => void;
}

/** Context menu for an item in the file list (file or directory). */
export function StorageContentContextMenu({
  menu,
  copiedPath,
  onClose,
  onDownloadFile,
  onDownloadFolder,
  onSetWorkingDirectory,
  onDelete,
  onCopyPath,
}: StorageContentContextMenuProps) {
  const { t } = useTranslation();
  const copied = copiedPath === menu.path;

  const items: StorageContextMenuItem[] =
    menu.type === 'file'
      ? [{ key: 'download', icon: Download, label: t('storage.download'), onClick: onDownloadFile }]
      : [
          {
            key: 'set-wd',
            icon: FolderCog,
            label: t('storage.setAsWorkingDirectory'),
            onClick: () => {
              onSetWorkingDirectory(menu.path);
              onClose();
            },
          },
          {
            key: 'download-folder',
            icon: Download,
            label: t('storage.downloadFolder'),
            onClick: onDownloadFolder,
          },
        ];

  items.push({ key: 'delete', icon: Trash2, label: t('common.delete'), onClick: onDelete });
  items.push({
    key: 'copy',
    icon: copied ? Check : Copy,
    label: copied ? t('storage.copied') : t('storage.copyPath'),
    confirmActive: copied,
    dividerBefore: true,
    onClick: () => onCopyPath(menu.path, onClose),
  });

  return <StorageContextMenu x={menu.x} y={menu.y} items={items} onClose={onClose} />;
}

export interface FolderMenuState {
  x: number;
  y: number;
  path: string;
  name: string;
}

export interface StorageFolderContextMenuProps {
  menu: FolderMenuState;
  copiedPath: string | null;
  onClose: () => void;
  onDownloadFolder: () => void;
  onSetWorkingDirectory: (path: string) => void;
  onDelete: () => void;
  onCopyPath: (path: string, closeMenu: () => void) => void;
}

/** Context menu for a folder in the left-hand tree. */
export function StorageFolderContextMenu({
  menu,
  copiedPath,
  onClose,
  onDownloadFolder,
  onSetWorkingDirectory,
  onDelete,
  onCopyPath,
}: StorageFolderContextMenuProps) {
  const { t } = useTranslation();
  const copied = copiedPath === menu.path;

  const items: StorageContextMenuItem[] = [
    {
      key: 'set-wd',
      icon: FolderCog,
      label: t('storage.setAsWorkingDirectory'),
      onClick: () => {
        onSetWorkingDirectory(menu.path);
        onClose();
      },
    },
    {
      key: 'download-folder',
      icon: Download,
      label: t('storage.downloadFolder'),
      onClick: onDownloadFolder,
    },
    { key: 'delete', icon: Trash2, label: t('common.delete'), onClick: onDelete },
    {
      key: 'copy',
      icon: copied ? Check : Copy,
      label: copied ? t('storage.copied') : t('storage.copyPath'),
      confirmActive: copied,
      dividerBefore: true,
      onClick: () => onCopyPath(menu.path, onClose),
    },
  ];

  return <StorageContextMenu x={menu.x} y={menu.y} items={items} onClose={onClose} />;
}
