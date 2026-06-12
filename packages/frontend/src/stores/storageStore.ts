/**
 * Storage Store
 * User file storage state management
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { StorageItem, ListStorageResponse, FolderNode } from '../api/storage';
import * as storageApi from '../api/storage';
import { logger } from '../utils/logger';
import { extractErrorMessage } from '../utils/store-helpers';

interface StorageState {
  // State
  currentPath: string;
  agentWorkingDirectory: string;
  items: StorageItem[];
  isLoading: boolean;
  error: string | null;
  isUploading: boolean;
  uploadProgress: number;
  uploadTotal: number;
  uploadCompleted: number;

  // Folder tree
  folderTree: FolderNode[];
  isTreeLoading: boolean;
  expandedFolders: string[];

  // Actions
  setCurrentPath: (path: string) => void;
  setAgentWorkingDirectory: (path: string) => void;
  loadItems: (path?: string) => Promise<void>;
  uploadFile: (file: File, path?: string) => Promise<void>;
  uploadFiles: (files: Array<{ file: File; relativePath: string }>) => Promise<void>;
  createDirectory: (directoryName: string, path?: string) => Promise<void>;
  deleteItem: (item: StorageItem) => Promise<void>;
  deleteItems: (items: StorageItem[]) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;

  // Folder tree actions
  loadFolderTree: () => Promise<void>;
  toggleFolderExpand: (path: string) => void;
  setExpandedFolders: (folders: string[]) => void;
}

export const useStorageStore = create<StorageState>()(
  devtools(
    persist(
      (set, get) => {
        // Silent sync helpers (no loading spinners)
        const silentSyncItems = async (targetPath: string): Promise<void> => {
          try {
            const response = await storageApi.listStorageItems(targetPath);
            // Only update if still on the same path
            if (targetPath === get().currentPath) {
              set({ items: response.items, currentPath: response.path });
            }
          } catch (syncError) {
            logger.error('Failed to silent sync items:', syncError);
          }
        };

        const silentSyncFolderTree = async (): Promise<void> => {
          try {
            const treeResponse = await storageApi.fetchFolderTree();
            set({ folderTree: treeResponse.tree });
          } catch (treeError) {
            logger.error('Failed to silent sync folder tree:', treeError);
          }
        };

        return {
          // Initial state
          currentPath: '/',
          agentWorkingDirectory: '/',
          items: [],
          isLoading: false,
          error: null,
          isUploading: false,
          uploadProgress: 0,
          uploadTotal: 0,
          uploadCompleted: 0,

          // Folder tree initial state
          folderTree: [],
          isTreeLoading: false,
          expandedFolders: ['/'],

          // Set path
          setCurrentPath: (path: string) => {
            set({ currentPath: path });
          },

          // Set agent working directory
          setAgentWorkingDirectory: (path: string) => {
            set({ agentWorkingDirectory: path });
            logger.log(`Agent working directory set to: ${path}`);
          },

          // Load item list
          loadItems: async (path?: string) => {
            const targetPath = path ?? get().currentPath;

            set({ isLoading: true, error: null });

            try {
              const response: ListStorageResponse = await storageApi.listStorageItems(targetPath);

              set({
                items: response.items,
                currentPath: response.path,
                isLoading: false,
              });
            } catch (error) {
              logger.error('Failed to load storage items:', error);
              set({
                error: extractErrorMessage(error, 'Failed to load storage items'),
                isLoading: false,
              });
            }
          },

          // Upload single file
          uploadFile: async (file: File, relativePathOrPath?: string) => {
            const relativePath = relativePathOrPath || file.name;
            await get().uploadFiles([{ file, relativePath }]);
          },

          // Batch upload multiple files
          uploadFiles: async (files: Array<{ file: File; relativePath: string }>) => {
            const currentPath = get().currentPath;
            const maxSize = 500 * 1024 * 1024; // 500MB

            // File size check
            const oversizedFiles = files.filter((f) => f.file.size > maxSize);
            if (oversizedFiles.length > 0) {
              set({
                error: `The following files exceed 500MB: ${oversizedFiles.map((f) => f.file.name).join(', ')}`,
              });
              return;
            }

            set({
              isUploading: true,
              uploadProgress: 0,
              uploadTotal: files.length,
              uploadCompleted: 0,
              error: null,
            });

            let completed = 0;
            const errors: string[] = [];

            try {
              // Upload each file sequentially
              for (const { file, relativePath } of files) {
                try {
                  let targetPath: string;
                  let fileName: string;

                  if (relativePath.includes('/')) {
                    // Relative path included
                    const pathParts = relativePath.split('/');
                    fileName = pathParts[pathParts.length - 1];
                    const dirPath = pathParts.slice(0, -1).join('/');
                    targetPath = currentPath === '/' ? `/${dirPath}` : `${currentPath}/${dirPath}`;
                  } else {
                    // File name only
                    fileName = relativePath;
                    targetPath = currentPath;
                  }

                  // Get signed URL
                  const uploadUrlResponse = await storageApi.generateUploadUrl(
                    fileName,
                    targetPath,
                    file.type
                  );

                  // Upload to S3
                  await storageApi.uploadFileToS3(uploadUrlResponse.uploadUrl, file);

                  completed++;
                  set({
                    uploadCompleted: completed,
                    uploadProgress: Math.round((completed / files.length) * 100),
                  });
                } catch (error) {
                  logger.error('Failed to upload file %s:', file.name, error);
                  errors.push(`${file.name}: ${extractErrorMessage(error, 'Unknown error')}`);
                }
              }

              // Refresh list and tree once after all uploads
              await get().loadItems(currentPath);
              await get().loadFolderTree();

              set({
                isUploading: false,
                uploadProgress: 100,
                uploadTotal: 0,
                uploadCompleted: 0,
              });

              // Show errors if any
              if (errors.length > 0) {
                set({
                  error: `Some files failed to upload:\n${errors.join('\n')}`,
                });
              }

              // Reset progress
              setTimeout(() => {
                set({ uploadProgress: 0 });
              }, 1000);
            } catch (error) {
              logger.error('Failed to upload files:', error);
              set({
                error: extractErrorMessage(error, 'Failed to upload files'),
                isUploading: false,
                uploadProgress: 0,
                uploadTotal: 0,
                uploadCompleted: 0,
              });
            }
          },

          // Create directory (optimistic UI)
          createDirectory: async (directoryName: string, path?: string) => {
            const targetPath = path ?? get().currentPath;
            const previousItems = get().items;

            // Optimistic update: add a placeholder directory item immediately
            const isCurrentPathTarget = targetPath === get().currentPath;
            if (isCurrentPathTarget) {
              const newDirPath =
                targetPath === '/' ? `/${directoryName}` : `${targetPath}/${directoryName}`;
              const optimisticItem: StorageItem = {
                name: directoryName,
                path: newDirPath,
                type: 'directory',
              };
              // Insert at the beginning (directories first), avoiding duplicates
              const filtered = previousItems.filter((i) => i.path !== newDirPath);
              const dirs = filtered.filter((i) => i.type === 'directory');
              const files = filtered.filter((i) => i.type === 'file');
              set({ items: [...dirs, optimisticItem, ...files], error: null });
            }

            try {
              await storageApi.createDirectory(directoryName, targetPath);

              // Silent sync: reload without showing loading spinner
              await silentSyncItems(targetPath);
              await silentSyncFolderTree();
            } catch (error) {
              logger.error('Failed to create directory:', error);
              // Rollback on failure
              if (isCurrentPathTarget) {
                set({ items: previousItems });
              }
              set({
                error: extractErrorMessage(error, 'Failed to create directory'),
              });
            }
          },

          // Delete a single item (delegates to batch delete)
          deleteItem: async (item: StorageItem) => {
            await get().deleteItems([item]);
          },

          // Delete multiple items in one batch (optimistic UI)
          deleteItems: async (items: StorageItem[]) => {
            if (items.length === 0) return;

            const previousItems = get().items;
            const targetPaths = new Set(items.map((i) => i.path));

            // Optimistic update: remove all targeted items immediately
            set({
              items: previousItems.filter((i) => !targetPaths.has(i.path)),
              error: null,
            });

            // Delete each item in parallel; collect per-item outcomes
            const results = await Promise.allSettled(
              items.map((item) =>
                item.type === 'file'
                  ? storageApi.deleteFile(item.path)
                  : // Force delete directory (including contents)
                    storageApi.deleteDirectory(item.path, true)
              )
            );

            // Identify failures and re-add only the items that failed to delete
            const failedItems: StorageItem[] = [];
            const errors: string[] = [];
            results.forEach((result, index) => {
              if (result.status === 'rejected') {
                const item = items[index];
                failedItems.push(item);
                logger.error('Failed to delete item %s:', item.path, result.reason);
                errors.push(`${item.name}: ${extractErrorMessage(result.reason, 'Unknown error')}`);
              }
            });

            if (failedItems.length > 0) {
              // Partial rollback: restore failed items in their original order
              const failedPaths = new Set(failedItems.map((i) => i.path));
              set({
                items: previousItems.filter(
                  (i) => failedPaths.has(i.path) || !targetPaths.has(i.path)
                ),
                error: errors.join('\n'),
              });
            }

            // Silent sync once after all deletions
            await silentSyncItems(get().currentPath);

            // Silent tree sync if any directory was deleted
            if (items.some((i) => i.type === 'directory')) {
              await silentSyncFolderTree();
            }
          },

          // Reload current path
          refresh: async () => {
            await get().loadItems();
          },

          // Clear errors
          clearError: () => {
            set({ error: null });
          },

          // Load folder tree (Stale-While-Revalidate pattern)
          loadFolderTree: async () => {
            const hasCachedData = get().folderTree.length > 0;

            // Only show loading spinner if no cached data
            if (!hasCachedData) {
              set({ isTreeLoading: true });
            }

            try {
              const response = await storageApi.fetchFolderTree();
              set({
                folderTree: response.tree,
                isTreeLoading: false,
              });
            } catch (error) {
              logger.error('Failed to load folder tree:', error);
              // Only show error if no cached data to display
              if (!hasCachedData) {
                set({
                  error: extractErrorMessage(error, 'Failed to load folder tree'),
                  isTreeLoading: false,
                });
              } else {
                // Silently fail if we have cached data
                set({ isTreeLoading: false });
              }
            }
          },

          // Toggle folder expand/collapse
          toggleFolderExpand: (path: string) => {
            const expandedFolders = [...get().expandedFolders];
            const index = expandedFolders.indexOf(path);
            if (index >= 0) {
              expandedFolders.splice(index, 1);
            } else {
              expandedFolders.push(path);
            }
            set({ expandedFolders });
          },

          // Set expanded folders
          setExpandedFolders: (folders: string[]) => {
            set({ expandedFolders: folders });
          },
        };
      },
      {
        name: 'storage-settings',
        partialize: (state) => ({
          currentPath: state.currentPath,
          agentWorkingDirectory: state.agentWorkingDirectory,
          expandedFolders: state.expandedFolders,
        }),
      }
    ),
    {
      name: 'storage-store',
      enabled: import.meta.env.DEV,
    }
  )
);
