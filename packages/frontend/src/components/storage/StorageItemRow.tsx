/**
 * A single row in the storage file list (file or directory).
 *
 * Presentational leaf: it receives the item plus selection state and callbacks,
 * and never touches the store. The `data-storage-path` attribute is REQUIRED —
 * the marquee selection hook locates rows by it.
 */

import { useTranslation } from 'react-i18next';
import { Folder, File, Download, Trash2, FolderCog } from 'lucide-react';
import type { StorageItem } from '../../api/storage';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import { getFileIcon } from '../../utils/fileIcons';
import { formatBytes } from '../../utils/formatBytes';

export interface StorageItemRowProps {
  item: StorageItem;
  onDelete: (item: StorageItem) => void;
  onNavigate: (path: string) => void;
  onDownload: (item: StorageItem) => void;
  onContextMenu: (e: React.MouseEvent, item: StorageItem) => void;
  onSetWorkingDirectory?: (path: string) => void;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: (item: StorageItem, e: React.MouseEvent) => void;
}

export function StorageItemRow({
  item,
  onDelete,
  onNavigate,
  onDownload,
  onContextMenu,
  onSetWorkingDirectory,
  selected,
  selectionActive,
  onToggleSelect,
}: StorageItemRowProps) {
  const { t } = useTranslation();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation(); // Stop card click event
    // Parent decides whether this is a single delete (with confirm) or a bulk
    // delete of the whole selection when this item is part of a multi-selection.
    onDelete(item);
  };

  const handleDownloadClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Stop card click event
    onDownload(item);
  };

  const handleCardClick = (e: React.MouseEvent) => {
    // While a selection exists, or with a modifier key, clicks toggle selection
    // instead of navigating/downloading (prevents accidental actions).
    if (selectionActive || e.metaKey || e.ctrlKey || e.shiftKey) {
      onToggleSelect(item, e);
      return;
    }
    if (item.type === 'directory') {
      onNavigate(item.path);
    } else {
      // Download if file
      onDownload(item);
    }
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger card navigation/download
    onToggleSelect(item, e);
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleContextMenuClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, item);
  };

  // Get file icon
  const fileIconConfig = item.type === 'file' ? getFileIcon(item.name) : null;
  const FileIcon = fileIconConfig?.icon;

  return (
    <div
      onClick={handleCardClick}
      onContextMenu={handleContextMenuClick}
      data-storage-path={item.path}
      className={`border rounded-lg p-3 transition-colors cursor-pointer ${
        selected
          ? 'border-action-primary bg-feedback-info-bg'
          : 'border-border hover:bg-surface-secondary'
      }`}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick(e as unknown as React.MouseEvent);
        }
      }}
    >
      <div className="flex items-center gap-3">
        {/* Selection checkbox */}
        <div className="flex-shrink-0 pr-1" onClick={handleCheckboxClick}>
          <input
            type="checkbox"
            checked={selected}
            readOnly
            aria-label={t('storage.selectItem', { name: item.name })}
            className="block w-4 h-4 rounded border-border-strong text-action-primary focus:ring-border-focus cursor-pointer"
          />
        </div>

        {/* Icon */}
        <div className="flex-shrink-0">
          {item.type === 'directory' ? (
            <Folder className="w-5 h-5 text-amber-500" />
          ) : FileIcon ? (
            <FileIcon className={`w-5 h-5 ${fileIconConfig.color}`} />
          ) : (
            <File className="w-5 h-5 text-action-primary" />
          )}
        </div>

        {/* Information */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-default truncate">{item.name}</div>
          <div className="flex items-center gap-4 text-xs text-fg-muted mt-1">
            {item.type === 'file' && (
              <span>{formatBytes(item.size, { emptyPlaceholder: '—' })}</span>
            )}
            <span className="hidden sm:inline">{formatDate(item.lastModified)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 sm:gap-2">
          {item.type === 'directory' && onSetWorkingDirectory && (
            <Tooltip content={t('storage.setAsWorkingDirectory')}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSetWorkingDirectory(item.path);
                }}
                className="p-2 text-fg-disabled hover:text-fg-secondary hover:bg-surface-secondary rounded-lg transition-colors"
                title={t('storage.setAsWorkingDirectory')}
              >
                <FolderCog className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
          <button
            onClick={handleDownloadClick}
            className="p-2 text-fg-disabled hover:text-action-primary hover:bg-feedback-info-bg rounded-lg transition-colors"
            title={item.type === 'directory' ? t('storage.downloadFolder') : t('storage.download')}
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={handleDelete}
            className="p-2 text-fg-disabled hover:text-feedback-error hover:bg-feedback-error-bg rounded-lg transition-colors"
            title={t('common.delete')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
