/**
 * Storage API Client
 * User file storage API
 */

import { backendClient } from './client/backend-client';
import { logger } from '../utils/logger';

export interface StorageItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: string;
  url?: string;
}

export interface ListStorageResponse {
  items: StorageItem[];
  path: string;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
}

export interface FolderTreeResponse {
  tree: FolderNode[];
}

/**
 * Normalize path (handles both encoded and unencoded paths)
 * Supports double-encoded, single-encoded, and unencoded paths
 */
function normalizeStoragePath(path: string): string {
  let normalized = path;

  // Attempt up to 2 decode passes (double-encoding protection)
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) {
        // No more decoding possible (already unencoded or fully decoded)
        break;
      }
      normalized = decoded;
    } catch {
      // Use current value if decode fails
      break;
    }
  }

  return normalized;
}

export interface DownloadFileInfo {
  relativePath: string;
  downloadUrl: string;
  size: number;
}

export interface FolderDownloadInfo {
  files: DownloadFileInfo[];
  totalSize: number;
  fileCount: number;
}

export interface DownloadProgress {
  current: number;
  total: number;
  percentage: number;
  currentFile: string;
}

export interface DirectorySizeResponse {
  totalSize: number;
  fileCount: number;
}

/**
 * List directory contents
 */
export async function listStorageItems(path: string = '/'): Promise<ListStorageResponse> {
  const params = new URLSearchParams();
  params.append('path', path);

  return backendClient.get<ListStorageResponse>(`/storage/list?${params.toString()}`);
}

/**
 * Get total size of all files in a directory recursively
 */
export async function getDirectorySize(path: string = '/'): Promise<DirectorySizeResponse> {
  const params = new URLSearchParams();
  params.append('path', path);

  return backendClient.get<DirectorySizeResponse>(`/storage/size?${params.toString()}`);
}

/**
 * Generate presigned URL for file upload
 */
export async function generateUploadUrl(
  fileName: string,
  path: string = '/',
  contentType?: string
): Promise<UploadUrlResponse> {
  return backendClient.post<UploadUrlResponse>('/storage/upload', {
    fileName,
    path,
    contentType,
  });
}

/**
 * Upload file to S3 using presigned URL
 * Note: This is direct S3 upload, not using backend client
 */
export async function uploadFileToS3(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload file to S3: ${response.statusText}`);
  }
}

/**
 * Create a directory
 */
export async function createDirectory(directoryName: string, path: string = '/') {
  return backendClient.post('/storage/directory', {
    directoryName,
    path,
  });
}

/**
 * Delete a file
 */
export async function deleteFile(path: string) {
  const params = new URLSearchParams();
  params.append('path', path);

  return backendClient.request(`/storage/file?${params.toString()}`, { method: 'DELETE' });
}

/**
 * Delete a directory
 * @param path Directory path
 * @param force If true, delete all files within the directory
 */
export async function deleteDirectory(path: string, force: boolean = false) {
  const params = new URLSearchParams();
  params.append('path', path);
  if (force) {
    params.append('force', 'true');
  }

  return backendClient.request(`/storage/directory?${params.toString()}`, { method: 'DELETE' });
}

/**
 * Generate presigned URL for file download
 */
export async function generateDownloadUrl(path: string): Promise<string> {
  const params = new URLSearchParams();
  // Normalize path (double-encoding protection)
  const normalizedPath = normalizeStoragePath(path);
  params.append('path', normalizedPath);

  const data = await backendClient.get<{ downloadUrl: string }>(
    `/storage/download?${params.toString()}`
  );

  return data.downloadUrl;
}

/**
 * Fetch folder tree structure
 */
export async function fetchFolderTree(): Promise<FolderTreeResponse> {
  return backendClient.get<FolderTreeResponse>('/storage/tree');
}

/**
 * Get download info for all files in a folder
 */
export async function getFolderDownloadInfo(path: string): Promise<FolderDownloadInfo> {
  const params = new URLSearchParams();
  params.append('path', path);

  return backendClient.get<FolderDownloadInfo>(`/storage/download-folder?${params.toString()}`);
}

/**
 * Download folder as ZIP
 * Note: Uses fflate (MIT license) for ZIP creation and Web standard API for download.
 */
export async function downloadFolder(
  folderPath: string,
  folderName: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const { zipSync } = await import('fflate');

  // Get file info for the folder
  const downloadInfo = await getFolderDownloadInfo(folderPath);

  if (downloadInfo.fileCount === 0) {
    throw new Error('Folder is empty');
  }

  const fileMap: Record<string, Uint8Array> = {};
  let downloadedCount = 0;

  // Download each file and add to ZIP
  for (const file of downloadInfo.files) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new Error('Download cancelled');
    }

    // Notify progress
    if (onProgress) {
      onProgress({
        current: downloadedCount,
        total: downloadInfo.fileCount,
        percentage: Math.round((downloadedCount / downloadInfo.fileCount) * 100),
        currentFile: file.relativePath,
      });
    }

    try {
      // Download file (direct S3 fetch, not using backend client)
      const response = await fetch(file.downloadUrl, { signal });

      if (!response.ok) {
        logger.error(`Failed to download file: ${file.relativePath}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      fileMap[file.relativePath] = new Uint8Array(arrayBuffer);

      downloadedCount++;
    } catch (error) {
      if (signal?.aborted) {
        throw new Error('Download cancelled', { cause: error });
      }
      logger.error('Error downloading file %s:', file.relativePath, error);
      // Skip and continue on error
      downloadedCount++;
    }
  }

  // Notify final progress
  if (onProgress) {
    onProgress({
      current: downloadedCount,
      total: downloadInfo.fileCount,
      percentage: 100,
      currentFile: 'Creating ZIP file...',
    });
  }

  // Generate ZIP using fflate (synchronous, runs in main thread)
  const zipped = zipSync(fileMap);
  const zipBlob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });

  // Trigger browser download using Web standard API
  const url = URL.createObjectURL(zipBlob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${folderName}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}
