/**
 * Storage Management Modal
 * Modal for managing user file storage
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Folder,
  File,
  Upload,
  FolderPlus,
  Trash2,
  Loader2,
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  Home,
  Download,
  Copy,
  Check,
  HelpCircle,
  FolderCog,
} from 'lucide-react';
import { useStorageStore } from '../stores/storageStore';
import type { StorageItem, FolderNode } from '../api/storage';
import { Modal } from './ui/Modal/Modal';
import {
  generateDownloadUrl,
  downloadFolder,
  getDirectorySize,
  type DownloadProgress,
} from '../api/storage';
import { Tooltip } from './ui/Tooltip/Tooltip';
import { FolderTree } from './FolderTree';
import { getFileIcon } from '../utils/fileIcons';
import { downloadWithAsyncUrl } from '../utils/download';
import { DownloadProgressModal } from './ui/DownloadProgressModal';
import { logger } from '../utils/logger';

interface StorageManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * File/directory item display component
 */
interface StorageItemComponentProps {
  item: StorageItem;
  onDelete: (item: StorageItem) => void;
  onNavigate: (path: string) => void;
  onDownload: (item: StorageItem) => void;
  onContextMenu: (e: React.MouseEvent, item: StorageItem) => void;
  onSetWorkingDirectory?: (path: string) => void;
}

function StorageItemComponent({
  item,
  onDelete,
  onNavigate,
  onDownload,
  onContextMenu,
  onSetWorkingDirectory,
}: StorageItemComponentProps) {
  const { t } = useTranslation();

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation(); // Stop card click event

    const confirmMessage =
      item.type === 'directory'
        ? t('storage.deleteDirectoryConfirm', { name: item.name })
        : t('storage.deleteFileConfirm', { name: item.name });

    if (window.confirm(confirmMessage)) {
      onDelete(item);
    }
  };

  const handleDownloadClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Stop card click event
    onDownload(item);
  };

  const handleCardClick = () => {
    if (item.type === 'directory') {
      onNavigate(item.path);
    } else {
      // Download if file
      onDownload(item);
    }
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      className="border border-border rounded-lg p-3 hover:bg-surface-secondary transition-colors cursor-pointer"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
    >
      <div className="flex items-center gap-3">
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
            {item.type === 'file' && <span>{formatSize(item.size)}</span>}
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
    clearError,
    loadFolderTree,
    toggleFolderExpand,
    setAgentWorkingDirectory,
  } = useStorageStore();

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
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const folderContextMenuRef = useRef<HTMLDivElement>(null);

  // Folder download related state
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    current: 0,
    total: 0,
    percentage: 0,
    currentFile: '',
  });
  const [downloadStatus, setDownloadStatus] = useState<
    'downloading' | 'success' | 'error' | 'cancelled'
  >('downloading');
  const [downloadError, setDownloadError] = useState<string>('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // Directory size warning state
  const SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100MB
  const [sizeWarning, setSizeWarning] = useState<{
    show: boolean;
    totalSize: number;
    fileCount: number;
  } | null>(null);

  // Format size for display
  const formatSizeForWarning = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  // Get path from URL hash
  const getPathFromHash = (): string => {
    const hash = window.location.hash;
    const match = hash.match(/#storage=(.+)/);
    return match ? decodeURIComponent(match[1]) : '/';
  };

  // Set path to URL hash
  const setPathToHash = (path: string) => {
    const newHash = `#storage=${encodeURIComponent(path)}`;
    window.history.pushState(null, '', newHash);
  };

  // Clear URL hash
  const clearHash = () => {
    if (window.location.hash.startsWith('#storage=')) {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  };

  // Load data when modal opens
  useEffect(() => {
    if (isOpen) {
      // Use URL hash if explicitly set,
      // otherwise use currently selected path (currentPath)
      const hasExplicitHash = window.location.hash.startsWith('#storage=');
      const initialPath = hasExplicitHash ? getPathFromHash() : agentWorkingDirectory || '/';

      // Set URL hash on initial display (add to history)
      setPathToHash(initialPath);
      loadItems(initialPath);
      // Also load folder tree
      loadFolderTree();
    } else {
      // Clear URL hash when closing modal
      clearHash();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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

  // Detect browser back/forward
  useEffect(() => {
    if (!isOpen) return;

    const handleHashChange = () => {
      if (window.location.hash.startsWith('#storage=')) {
        const pathFromHash = getPathFromHash();
        // Call store method directly
        useStorageStore.getState().loadItems(pathFromHash);
      } else {
        // Close modal if no hash
        onClose();
      }
    };

    window.addEventListener('popstate', handleHashChange);
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('popstate', handleHashChange);
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, [isOpen, onClose]);

  // Detect outside click of context menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
      if (
        folderContextMenuRef.current &&
        !folderContextMenuRef.current.contains(event.target as Node)
      ) {
        setFolderContextMenu(null);
      }
    };

    if (contextMenu || folderContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [contextMenu, folderContextMenu]);

  // Path navigation
  const handleNavigate = (path: string) => {
    setPathToHash(path);
    loadItems(path);
  };

  const handleNavigateToRoot = () => {
    setPathToHash('/');
    loadItems('/');
  };

  // Create breadcrumb list
  const pathSegments = currentPath.split('/').filter(Boolean);

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

  // Recursively get files and directories from directory entry
  const readDirectoryEntry = async (
    directoryEntry: FileSystemDirectoryEntry,
    path: string = ''
  ): Promise<{
    files: Array<{ file: File; relativePath: string }>;
    directories: string[];
  }> => {
    const files: Array<{ file: File; relativePath: string }> = [];
    const directories: string[] = [];
    const reader = directoryEntry.createReader();

    const readEntries = (): Promise<FileSystemEntry[]> => {
      return new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
    };

    const entries = await readEntries();

    // Empty directory if no entry
    if (entries.length === 0) {
      directories.push(path);
      return { files, directories };
    }

    for (const entry of entries) {
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject);
        });
        files.push({
          file,
          relativePath: path ? `${path}/${entry.name}` : entry.name,
        });
      } else if (entry.isDirectory) {
        const dirEntry = entry as FileSystemDirectoryEntry;
        const subPath = path ? `${path}/${entry.name}` : entry.name;
        const result = await readDirectoryEntry(dirEntry, subPath);
        files.push(...result.files);
        directories.push(...result.directories);
      }
    }

    return { files, directories };
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

    // Process folder using DataTransferItem
    const allFiles: Array<{ file: File; relativePath: string }> = [];
    const allDirectories: string[] = [];

    // [IMPORTANT] DataTransferItemList can only be accessed synchronously,
    // so get all entries synchronously first
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          entries.push(entry);
        }
      }
    }

    // Execute async processing after getting entries
    for (const entry of entries) {
      if (entry.isFile) {
        // If file
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject);
        });
        allFiles.push({ file, relativePath: file.name });
      } else if (entry.isDirectory) {
        // If directory, read recursively
        const dirEntry = entry as FileSystemDirectoryEntry;
        const result = await readDirectoryEntry(dirEntry, entry.name);
        allFiles.push(...result.files);
        allDirectories.push(...result.directories);
      }
    }

    // Create empty directory first
    for (const dirPath of allDirectories) {
      // Calculate parent path using last segment of dirPath as directory name
      const pathParts = dirPath.split('/');
      const dirName = pathParts[pathParts.length - 1];
      const parentPath =
        pathParts.length > 1
          ? currentPath === '/'
            ? `/${pathParts.slice(0, -1).join('/')}`
            : `${currentPath}/${pathParts.slice(0, -1).join('/')}`
          : currentPath;

      await createDirectory(dirName, parentPath);
    }

    // Batch upload all files
    if (allFiles.length > 0) {
      await uploadFiles(allFiles);
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

    await createDirectory(newDirectoryName);
    setNewDirectoryName('');
    setShowNewDirectoryInput(false);
  };

  // Download
  const handleDownload = async (item: StorageItem) => {
    if (item.type === 'directory') {
      // ZIP download for folders
      await handleFolderDownload(item.path, item.name);
    } else {
      // Open window synchronously within user gesture context (before await)
      // This preserves transient activation on mobile browsers
      await downloadWithAsyncUrl(
        () => generateDownloadUrl(item.path),
        (error) => {
          logger.error('Download error:', error);
        }
      );
    }
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
      await handleDownload(item);
    }
    setContextMenu(null);
  };

  // Delete from content panel context menu
  const handleContextDelete = async () => {
    if (!contextMenu) return;
    const item = items.find((i) => i.path === contextMenu.path);
    if (item) {
      const confirmMessage =
        item.type === 'directory'
          ? t('storage.deleteDirectoryConfirm', { name: item.name })
          : t('storage.deleteFileConfirm', { name: item.name });

      if (window.confirm(confirmMessage)) {
        setContextMenu(null);
        await deleteItem(item);
      } else {
        setContextMenu(null);
      }
    }
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

  // Folder download
  const handleFolderDownload = async (folderPath: string, folderName: string) => {
    // Open modal and start showing progress
    setDownloadStatus('downloading');
    setDownloadError('');
    setDownloadProgress({ current: 0, total: 0, percentage: 0, currentFile: '' });
    setIsDownloadModalOpen(true);

    // Create AbortController
    abortControllerRef.current = new AbortController();

    try {
      await downloadFolder(
        folderPath,
        folderName,
        (progress) => {
          setDownloadProgress(progress);
        },
        abortControllerRef.current.signal
      );

      // Success
      setDownloadStatus('success');
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Download cancelled') {
          setDownloadStatus('cancelled');
        } else {
          setDownloadStatus('error');
          setDownloadError(error.message);
        }
      } else {
        setDownloadStatus('error');
        setDownloadError('Unknown error occurred');
      }
    } finally {
      abortControllerRef.current = null;
    }
  };

  // Cancel download
  const handleCancelDownload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  // Close download modal
  const handleCloseDownloadModal = () => {
    setIsDownloadModalOpen(false);
    setDownloadProgress({ current: 0, total: 0, percentage: 0, currentFile: '' });
    setDownloadError('');
  };

  // Folder download from context menu
  const handleContextFolderDownload = async () => {
    if (!contextMenu) return;
    const item = items.find((i) => i.path === contextMenu.path);
    if (item && item.type === 'directory') {
      setContextMenu(null);
      await handleFolderDownload(item.path, item.name);
    }
  };

  // Folder download from folder tree context menu
  const handleTreeFolderDownload = async () => {
    if (!folderContextMenu) return;
    setFolderContextMenu(null);
    await handleFolderDownload(folderContextMenu.path, folderContextMenu.name);
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

      {/* Toolbar */}
      <div className="px-4 md:px-6 py-2.5 border-b border-border bg-surface-secondary">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t('storage.upload')}</span>
          </button>

          <button
            onClick={() => setShowNewDirectoryInput(true)}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span>{t('storage.newFolder')}</span>
          </button>

          <button
            onClick={() => setAgentWorkingDirectory(currentPath)}
            disabled={agentWorkingDirectory === currentPath}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <FolderCog className="w-3.5 h-3.5" />
            <span>{t('storage.setAsWorkingDirectory')}</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
        </div>

        {/* Upload progress */}
        {isUploading && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs sm:text-sm text-fg-secondary mb-1">
              <span className="truncate">
                {uploadTotal > 0
                  ? t('storage.uploadingProgress', {
                      completed: uploadCompleted,
                      total: uploadTotal,
                    })
                  : t('storage.uploading')}
              </span>
              <span className="ml-2">{uploadProgress}%</span>
            </div>
            <div className="w-full bg-border rounded-full h-2">
              <div
                className="bg-action-primary h-2 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>

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
          <div className="px-4 md:px-6 py-3 border-b border-border bg-surface-primary">
            <div className="flex items-center gap-2">
              {/* Breadcrumb section (scrollable) */}
              <div className="flex items-center gap-1 text-sm overflow-x-auto flex-1 min-w-0">
                <button
                  onClick={handleNavigateToRoot}
                  className="flex items-center gap-1 px-2 py-1 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors whitespace-nowrap"
                >
                  <Home className="w-4 h-4 flex-shrink-0" />
                  <span>{t('storage.root')}</span>
                </button>

                {pathSegments.map((segment, index) => {
                  const segmentPath = '/' + pathSegments.slice(0, index + 1).join('/');
                  return (
                    <div key={segmentPath} className="flex items-center gap-1">
                      <ChevronRight className="w-4 h-4 text-fg-disabled flex-shrink-0" />
                      <button
                        onClick={() => handleNavigate(segmentPath)}
                        className="px-2 py-1 text-fg-secondary hover:text-fg-default hover:bg-surface-secondary rounded transition-colors truncate max-w-[120px] sm:max-w-none"
                      >
                        {segment}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Directory size warning icon (outside overflow container) */}
              {sizeWarning?.show && (
                <Tooltip
                  content={
                    <div className="text-xs leading-relaxed">
                      <p className="font-medium">{t('storage.largeSizeWarningTitle')}</p>
                      <p className="mt-1">
                        {t('storage.largeSizeWarningMessage', {
                          size: formatSizeForWarning(sizeWarning.totalSize),
                          count: sizeWarning.fileCount,
                        })}
                      </p>
                    </div>
                  }
                  position="left"
                  width="320px"
                >
                  <div className="flex-shrink-0 p-1 cursor-help">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                  </div>
                </Tooltip>
              )}
            </div>
          </div>

          {/* File list */}
          <div
            className={`flex-1 overflow-y-auto px-4 md:px-6 py-4 relative ${
              isDragOver ? 'bg-feedback-info-bg' : ''
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
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
                    {items.map((item) => (
                      <StorageItemComponent
                        key={item.path}
                        item={item}
                        onDelete={deleteItem}
                        onNavigate={handleNavigate}
                        onDownload={handleDownload}
                        onContextMenu={handleContextMenu}
                        onSetWorkingDirectory={setAgentWorkingDirectory}
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
          <div
            ref={contextMenuRef}
            className="fixed bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-50 min-w-[160px]"
            style={{
              left: `${Math.min(contextMenu.x, window.innerWidth - 180)}px`,
              top: `${Math.min(contextMenu.y, window.innerHeight - 200)}px`,
            }}
          >
            {contextMenu.type === 'file' ? (
              <button
                onClick={handleContextDownload}
                className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
              >
                <Download className="w-4 h-4 text-fg-secondary" />
                <span className="text-fg-default">{t('storage.download')}</span>
              </button>
            ) : (
              <>
                <button
                  onClick={() => {
                    setAgentWorkingDirectory(contextMenu.path);
                    setContextMenu(null);
                  }}
                  className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
                >
                  <FolderCog className="w-4 h-4 text-fg-secondary" />
                  <span className="text-fg-default">{t('storage.setAsWorkingDirectory')}</span>
                </button>
                <button
                  onClick={handleContextFolderDownload}
                  className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
                >
                  <Download className="w-4 h-4 text-fg-secondary" />
                  <span className="text-fg-default">{t('storage.downloadFolder')}</span>
                </button>
              </>
            )}
            <button
              onClick={handleContextDelete}
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              <Trash2 className="w-4 h-4 text-fg-secondary" />
              <span className="text-fg-default">{t('common.delete')}</span>
            </button>
            <div className="border-t border-border my-1" />
            <button
              onClick={() => handleCopyPath(contextMenu.path, () => setContextMenu(null))}
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              {copiedPath === contextMenu.path ? (
                <>
                  <Check className="w-4 h-4 text-green-600" />
                  <span className="text-green-600">{t('storage.copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 text-fg-secondary" />
                  <span className="text-fg-default">{t('storage.copyPath')}</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Folder tree context menu */}
        {folderContextMenu && (
          <div
            ref={folderContextMenuRef}
            className="fixed bg-surface-primary rounded-lg shadow-lg border border-border py-1 z-50 min-w-[160px]"
            style={{
              left: `${Math.min(folderContextMenu.x, window.innerWidth - 180)}px`,
              top: `${Math.min(folderContextMenu.y, window.innerHeight - 200)}px`,
            }}
          >
            <button
              onClick={() => {
                setAgentWorkingDirectory(folderContextMenu.path);
                setFolderContextMenu(null);
              }}
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              <FolderCog className="w-4 h-4 text-fg-secondary" />
              <span className="text-fg-default">{t('storage.setAsWorkingDirectory')}</span>
            </button>
            <button
              onClick={handleTreeFolderDownload}
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              <Download className="w-4 h-4 text-fg-secondary" />
              <span className="text-fg-default">{t('storage.downloadFolder')}</span>
            </button>
            <button
              onClick={handleFolderDelete}
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              <Trash2 className="w-4 h-4 text-fg-secondary" />
              <span className="text-fg-default">{t('common.delete')}</span>
            </button>
            <div className="border-t border-border my-1" />
            <button
              onClick={() =>
                handleCopyPath(folderContextMenu.path, () => setFolderContextMenu(null))
              }
              className="w-full px-4 py-2 text-sm text-left hover:bg-surface-secondary flex items-center gap-2 transition-colors"
            >
              {copiedPath === folderContextMenu.path ? (
                <>
                  <Check className="w-4 h-4 text-green-600" />
                  <span className="text-green-600">{t('storage.copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 text-fg-secondary" />
                  <span className="text-fg-default">{t('storage.copyPath')}</span>
                </>
              )}
            </button>
          </div>
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
      <DownloadProgressModal
        isOpen={isDownloadModalOpen}
        onClose={handleCloseDownloadModal}
        progress={downloadProgress}
        status={downloadStatus}
        errorMessage={downloadError}
        onCancel={downloadStatus === 'downloading' ? handleCancelDownload : undefined}
      />
    </Modal>
  );
}
