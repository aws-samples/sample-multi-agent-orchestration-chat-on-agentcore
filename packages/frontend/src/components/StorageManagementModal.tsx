/**
 * Storage Management Modal
 * Modal for managing user file storage
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Folder, Upload, Loader2, AlertCircle, Check, HelpCircle } from 'lucide-react';
import { useStorageStore } from '../stores/storageStore';
import type { StorageItem, FolderNode } from '../api/storage';
import { Modal } from './ui/Modal/Modal';
import { ConfirmModal } from './ui/Modal/ConfirmModal';
import {
  StorageContentContextMenu,
  StorageFolderContextMenu,
} from './storage/StorageContextMenu';
import { StorageItemRow } from './storage/StorageItemRow';
import { StorageBreadcrumb } from './storage/StorageBreadcrumb';
import { StorageToolbar } from './storage/StorageToolbar';
import { getDirectorySize } from '../api/storage';
import { Tooltip } from './ui/Tooltip/Tooltip';
import { FolderTree } from './FolderTree';
import {
  collectDropEntries,
  readDroppedEntries,
  resolveDirectoryCreation,
} from '../utils/fileSystemEntry';
import { useStorageSelection } from '../hooks/useStorageSelection';
import { useFolderDownload } from '../hooks/useFolderDownload';
import { useStorageHashSync } from '../hooks/useStorageHashSync';
import { DownloadProgressModal } from './ui/DownloadProgressModal';
import { logger } from '../utils/logger';

interface StorageManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Storage Management Modal
 */
export function StorageManagementModal({ isOpen, onClose }: StorageManagementModalProps) {
  const { t } = useTranslation();
  const {
    currentPath,
    agentWorkingDirectory,
    items,
    isLoading,
    error,
    isUploading,
    uploadProgress,
    uploadTotal,
    uploadCompleted,
    folderTree,
    isTreeLoading,
    expandedFolders,
    loadItems,
    uploadFiles,
    createDirectory,
    deleteItem,
    deleteItems,
    clearError,
    loadFolderTree,
    toggleFolderExpand,
    setAgentWorkingDirectory,
  } = useStorageStore();

  // Multi-select + marquee drag-selection (checkbox/range/select-all/rubber-band).
  const listContainerRef = useRef<HTMLDivElement>(null);
  const {
    selectedPaths,
    selectedItems,
    allSelected,
    someSelected,
    marqueeRect,
    toggle: handleToggleSelect,
    toggleAll: handleToggleSelectAll,
    clear: clearSelection,
    deselect: deselectPaths,
    onListMouseDown: handleListMouseDown,
  } = useStorageSelection(items, listContainerRef, isOpen);

  // Items pending deletion via the confirm modal. Drives both the bulk-bar
  // delete and per-item delete (when the item belongs to a multi-selection).
  const [pendingDeleteItems, setPendingDeleteItems] = useState<StorageItem[]>([]);
  const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState(false);

  const [newDirectoryName, setNewDirectoryName] = useState('');
  const [showNewDirectoryInput, setShowNewDirectoryInput] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    type: 'file' | 'directory';
  } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    name: string;
  } | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Download orchestration (single-file, folder/bulk ZIP, progress, cancel).
  const { modalProps: downloadModalProps, downloadItem, downloadFolderAsZip, downloadSelection } =
    useFolderDownload(t);

  // URL-hash <-> current-path sync (deep links, Back/Forward, close-on-back).
  const { setPathToHash } = useStorageHashSync({
    isOpen,
    onClose,
    agentWorkingDirectory,
    loadItems,
    loadFolderTree,
  });

  // Directory size warning state
  const SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100MB
  const [sizeWarning, setSizeWarning] = useState<{
    show: boolean;
    totalSize: number;
    fileCount: number;
  } | null>(null);

  // Check directory size when path changes
  useEffect(() => {
    if (!isOpen) return;

    const checkDirectorySize = async () => {
      try {
        const sizeInfo = await getDirectorySize(currentPath);
        if (sizeInfo.totalSize >= SIZE_WARNING_THRESHOLD) {
          setSizeWarning({
            show: true,
            totalSize: sizeInfo.totalSize,
            fileCount: sizeInfo.fileCount,
          });
        } else {
          setSizeWarning(null);
        }
      } catch (err) {
        logger.error('Failed to get directory size:', err);
        setSizeWarning(null);
      }
    };

    checkDirectorySize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, currentPath]);

  // Path navigation (clears selection — the new directory has its own items)
  const handleNavigate = (path: string) => {
    clearSelection();
    setPathToHash(path);
    loadItems(path);
  };

  const handleNavigateToRoot = () => {
    clearSelection();
    setPathToHash('/');
    loadItems('/');
  };

  // File upload (batch processing)
  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const fileArray: Array<{ file: File; relativePath: string }> = [];
    for (let i = 0; i < files.length; i++) {
      fileArray.push({
        file: files[i],
        relativePath: files[i].name,
      });
    }

    await uploadFiles(fileArray);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(e.target.files);
    // Reset
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Drag & drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const items = e.dataTransfer.items;

    if (!items) {
      // Fallback: Normal file list
      const files = e.dataTransfer.files;
      await handleFileSelect(files);
      return;
    }

    // [IMPORTANT] DataTransferItemList is only valid synchronously, so collect
    // the top-level entries before any await, then walk them asynchronously.
    const entries = collectDropEntries(items);
    const { files, directories } = await readDroppedEntries(entries);

    // Create empty directories first (files carry their own nested paths).
    for (const dirPath of directories) {
      const { dirName, parentPath } = resolveDirectoryCreation(dirPath, currentPath);
      await createDirectory(dirName, parentPath);
    }

    // Batch upload all files
    if (files.length > 0) {
      await uploadFiles(files);
    }
  };

  // Create directory
  const handleCreateDirectory = async () => {
    if (!newDirectoryName.trim()) return;

    // Validation: error if it contains half-width or full-width spaces
    if (/[\s\u3000]/.test(newDirectoryName)) {
      alert(t('storage.folderNameSpaceError'));
      return;
    }

    // Close the form immediately. The store applies an optimistic item update
    // and rolls back (surfacing `error`) on failure, so closing the input must
    // not wait on createDirectory's awaited item/tree sync — otherwise a slow
    // folder-tree fetch leaves the input stuck open even though the folder was
    // already created.
    const name = newDirectoryName;
    setNewDirectoryName('');
    setShowNewDirectoryInput(false);
    await createDirectory(name);
  };


  // Show context menu of content panel
  const handleContextMenu = (e: React.MouseEvent, item: StorageItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      path: item.path,
      type: item.type,
    });
  };

  // Show context menu of folder tree
  const handleFolderContextMenu = (e: React.MouseEvent, node: FolderNode) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderContextMenu({
      x: e.clientX,
      y: e.clientY,
      path: node.path,
      name: node.name,
    });
  };

  // Copy path
  const handleCopyPath = async (path: string, closeMenu: () => void) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      setTimeout(() => {
        setCopiedPath(null);
        closeMenu();
      }, 1500);
    } catch (error) {
      logger.error('Copy error:', error);
      closeMenu();
    }
  };

  // Download from content panel context menu
  const handleContextDownload = async () => {
    if (!contextMenu) return;
    const item = items.find((i) => i.path === contextMenu.path);
    if (item && item.type === 'file') {
      await downloadItem(item);
    }
    setContextMenu(null);
  };

  // Delete from content panel context menu. Like the card button, this deletes
  // the whole selection when the right-clicked item is part of a multi-selection.
  const handleContextDelete = () => {
    if (!contextMenu) return;
    const item = items.find((i) => i.path === contextMenu.path);
    setContextMenu(null);
    if (!item) return;
    handleItemDelete(item);
  };

  // Delete from folder tree context menu
  const handleFolderDelete = async () => {
    if (!folderContextMenu) return;

    const confirmMessage = t('storage.deleteDirectoryConfirm', { name: folderContextMenu.name });

    if (window.confirm(confirmMessage)) {
      setFolderContextMenu(null);
      const folderItem: StorageItem = {
        name: folderContextMenu.name,
        path: folderContextMenu.path,
        type: 'directory',
      };
      await deleteItem(folderItem);
    } else {
      setFolderContextMenu(null);
    }
  };

  // Bulk download selected items as a single ZIP (clears selection on success).
  const handleBulkDownload = () => downloadSelection(selectedItems, clearSelection);

  // Open the confirm modal for the bulk-bar "delete selected" action.
  const handleBulkDeleteRequest = () => {
    if (selectedItems.length === 0) return;
    setPendingDeleteItems(selectedItems);
    setIsBulkDeleteConfirmOpen(true);
  };

  // Per-item delete (card button). When the item is part of a multi-selection,
  // delete the whole selection at once; otherwise delete just that item.
  const handleItemDelete = (item: StorageItem) => {
    if (selectedPaths.has(item.path) && selectedItems.length > 1) {
      setPendingDeleteItems(selectedItems);
    } else {
      setPendingDeleteItems([item]);
    }
    setIsBulkDeleteConfirmOpen(true);
  };

  // Confirmed deletion of whatever is pending (single or bulk).
  const handleDeleteConfirmed = async () => {
    const targets = [...pendingDeleteItems];
    // Drop deleted items from the current selection.
    deselectPaths(targets.map((i) => i.path));
    setPendingDeleteItems([]);
    await deleteItems(targets);
  };

  // Folder download from context menu
  const handleContextFolderDownload = async () => {
    if (!contextMenu) return;
    const item = items.find((i) => i.path === contextMenu.path);
    if (item && item.type === 'directory') {
      setContextMenu(null);
      await downloadFolderAsZip(item.path, item.name);
    }
  };

  // Folder download from folder tree context menu
  const handleTreeFolderDownload = async () => {
    if (!folderContextMenu) return;
    setFolderContextMenu(null);
    await downloadFolderAsZip(folderContextMenu.path, folderContextMenu.name);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      className="md:max-w-6xl md:h-[85vh] max-w-full h-screen"
    >
      {/* Header */}
      <div className="border-b border-border px-4 md:px-6 py-3 md:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Folder className="w-5 h-5 text-amber-500" />
            <h2 className="text-base md:text-lg font-semibold text-fg-default">
              {t('storage.fileStorage')}
            </h2>
            <Tooltip
              content={<div className="text-xs leading-relaxed">{t('storage.description')}</div>}
              position="bottom"
              width="480px"
            >
              <button className="w-6 h-6 rounded-full hover:bg-surface-secondary flex items-center justify-center text-fg-secondary transition-colors">
                <HelpCircle className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-fg-disabled hover:text-fg-secondary hover:bg-surface-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {/* Working directory display */}
        <div className="mt-2 text-xs text-fg-secondary">
          <span className="font-medium">{t('storage.workingDirectory')}:</span>{' '}
          <span className="font-mono">{agentWorkingDirectory}</span>
        </div>
      </div>

      {/* Toolbar (default actions or bulk action bar) */}
      <StorageToolbar
        selectedCount={selectedPaths.size}
        onBulkDownload={handleBulkDownload}
        onBulkDelete={handleBulkDeleteRequest}
        onClearSelection={clearSelection}
        canSetWorkingDirectory={agentWorkingDirectory !== currentPath}
        onUploadClick={() => fileInputRef.current?.click()}
        onNewFolder={() => setShowNewDirectoryInput(true)}
        onSetWorkingDirectory={() => setAgentWorkingDirectory(currentPath)}
        upload={{ isUploading, uploadProgress, uploadTotal, uploadCompleted }}
      />
      {/* Hidden file input (owned by the modal; triggered from the toolbar) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Content area: responsive layout */}
      <div className="flex divide-x divide-gray-200 flex-1 min-h-0">
        {/* Left column: folder tree - desktop only */}
        <div className="hidden md:block md:w-[240px] flex-shrink-0 overflow-y-auto bg-surface-secondary">
          <div className="px-3 py-2">
            <div className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2 px-2">
              {t('storage.folders')}
            </div>
            <FolderTree
              tree={folderTree}
              selectedPath={currentPath}
              workingDirectoryPath={agentWorkingDirectory}
              expandedPaths={expandedFolders}
              onSelect={handleNavigate}
              onToggleExpand={toggleFolderExpand}
              onContextMenu={handleFolderContextMenu}
              isLoading={isTreeLoading}
            />
          </div>
        </div>

        {/* Right column: file list */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Breadcrumb navigation */}
          <StorageBreadcrumb
            currentPath={currentPath}
            onNavigate={handleNavigate}
            onNavigateToRoot={handleNavigateToRoot}
            sizeWarning={sizeWarning}
          />

          {/* File list */}
          <div
            ref={listContainerRef}
            className={`flex-1 overflow-y-auto px-4 md:px-6 py-4 relative select-none ${
              isDragOver ? 'bg-feedback-info-bg' : ''
            } ${marqueeRect ? 'cursor-crosshair' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onMouseDown={handleListMouseDown}
          >
            {/* Marquee selection rectangle */}
            {marqueeRect && (
              <div
                className="absolute z-10 border border-action-primary bg-action-primary/10 pointer-events-none rounded-sm"
                style={{
                  left: `${marqueeRect.left}px`,
                  top: `${marqueeRect.top}px`,
                  width: `${marqueeRect.width}px`,
                  height: `${marqueeRect.height}px`,
                }}
              />
            )}
            {/* Error display */}
            {error && (
              <div className="mb-4 p-3 bg-feedback-error-bg border border-feedback-error-border rounded-lg flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-feedback-error mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-feedback-error break-words">{error}</p>
                  <button
                    onClick={clearError}
                    className="text-sm text-feedback-error hover:text-feedback-error font-medium mt-1"
                  >
                    {t('common.close')}
                  </button>
                </div>
              </div>
            )}

            {/* Loading */}
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-fg-disabled" />
                <span className="ml-2 text-sm text-fg-secondary">{t('common.loading')}</span>
              </div>
            )}

            {/* Item list */}
            {!isLoading && (
              <>
                {items.length === 0 && !showNewDirectoryInput ? (
                  <div className="text-center py-12">
                    <Folder className="w-12 h-12 text-fg-disabled mx-auto mb-4" />
                    <p className="text-sm text-fg-secondary mb-2">{t('storage.emptyFolder')}</p>
                    <p className="text-xs text-fg-muted">{t('storage.dragAndDropHint')}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Select-all header */}
                    {items.length > 0 && (
                      <div className="flex items-center gap-3 px-3 pb-1">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          onChange={handleToggleSelectAll}
                          aria-label={t('storage.selectAll')}
                          className="block w-4 h-4 rounded border-border-strong text-action-primary focus:ring-border-focus cursor-pointer"
                        />
                        <span className="text-xs text-fg-muted">{t('storage.selectAll')}</span>
                      </div>
                    )}
                    {items.map((item) => (
                      <StorageItemRow
                        key={item.path}
                        item={item}
                        onDelete={handleItemDelete}
                        onNavigate={handleNavigate}
                        onDownload={downloadItem}
                        onContextMenu={handleContextMenu}
                        onSetWorkingDirectory={setAgentWorkingDirectory}
                        selected={selectedPaths.has(item.path)}
                        selectionActive={selectedPaths.size > 0}
                        onToggleSelect={handleToggleSelect}
                      />
                    ))}

                    {/* New directory input (at end of list) */}
                    {showNewDirectoryInput && (
                      <div className="border border-feedback-info-border rounded-lg p-3 bg-feedback-info-bg">
                        <div className="flex items-center gap-3">
                          <Folder className="w-5 h-5 text-amber-500 flex-shrink-0" />
                          <input
                            type="text"
                            value={newDirectoryName}
                            onChange={(e) => setNewDirectoryName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleCreateDirectory();
                              if (e.key === 'Escape') {
                                setShowNewDirectoryInput(false);
                                setNewDirectoryName('');
                              }
                            }}
                            placeholder={t('storage.folderNamePlaceholder')}
                            className="flex-1 px-2 py-1.5 text-sm border border-border-strong rounded focus:outline-none focus:ring-2 focus:ring-border-focus"
                            autoFocus
                          />
                          <button
                            onClick={handleCreateDirectory}
                            disabled={!newDirectoryName.trim()}
                            className="flex-shrink-0 p-2 text-action-primary hover:bg-blue-100 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title={t('storage.create')}
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              setShowNewDirectoryInput(false);
                              setNewDirectoryName('');
                            }}
                            className="flex-shrink-0 p-2 text-fg-disabled hover:text-feedback-error hover:bg-feedback-error-bg rounded transition-colors"
                            title={t('common.cancel')}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Overlay when dragging over */}
            {isDragOver && (
              <div className="absolute inset-0 flex items-center justify-center bg-feedback-info-bg/90 pointer-events-none">
                <div className="text-center">
                  <Upload className="w-12 h-12 text-action-primary mx-auto mb-2" />
                  <p className="text-lg font-medium text-action-primary">
                    {t('storage.dropFiles')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Content panel context menu */}
        {contextMenu && (
          <StorageContentContextMenu
            menu={contextMenu}
            copiedPath={copiedPath}
            onClose={() => setContextMenu(null)}
            onDownloadFile={handleContextDownload}
            onDownloadFolder={handleContextFolderDownload}
            onSetWorkingDirectory={setAgentWorkingDirectory}
            onDelete={handleContextDelete}
            onCopyPath={handleCopyPath}
          />
        )}

        {/* Folder tree context menu */}
        {folderContextMenu && (
          <StorageFolderContextMenu
            menu={folderContextMenu}
            copiedPath={copiedPath}
            onClose={() => setFolderContextMenu(null)}
            onDownloadFolder={handleTreeFolderDownload}
            onSetWorkingDirectory={setAgentWorkingDirectory}
            onDelete={handleFolderDelete}
            onCopyPath={handleCopyPath}
          />
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 md:px-6 py-3 md:py-4 bg-surface-secondary">
        <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 sm:gap-0">
          <p className="text-xs text-fg-muted">{t('storage.itemCount', { count: items.length })}</p>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-fg-secondary bg-surface-primary border border-border-strong rounded-md hover:bg-surface-secondary transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      {/* Download progress modal */}
      <DownloadProgressModal {...downloadModalProps} />

      {/* Delete confirmation modal (single or bulk) */}
      <ConfirmModal
        isOpen={isBulkDeleteConfirmOpen}
        onClose={() => {
          setIsBulkDeleteConfirmOpen(false);
          setPendingDeleteItems([]);
        }}
        onConfirm={handleDeleteConfirmed}
        title={t('storage.bulkDeleteConfirmTitle')}
        message={
          pendingDeleteItems.length === 1
            ? pendingDeleteItems[0].type === 'directory'
              ? t('storage.deleteDirectoryConfirm', { name: pendingDeleteItems[0].name })
              : t('storage.deleteFileConfirm', { name: pendingDeleteItems[0].name })
            : t('storage.bulkDeleteConfirm', {
                count: pendingDeleteItems.length,
                folders: pendingDeleteItems.filter((i) => i.type === 'directory').length,
                files: pendingDeleteItems.filter((i) => i.type === 'file').length,
              })
        }
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        variant="danger"
      />
    </Modal>
  );
}
