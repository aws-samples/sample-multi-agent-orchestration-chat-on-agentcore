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

/**
 * Result of a ZIP download: how many files were requested vs. actually
 * included. `failed > 0` means the ZIP is incomplete (some files could not be
 * fetched, e.g. expired presigned URLs) and the caller should warn the user.
 */
export interface DownloadResult {
  total: number;
  succeeded: number;
  failed: number;
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
 * Download a set of files into a single ZIP, reporting progress.
 * Each entry maps a ZIP-internal path to a presigned S3 download URL.
 *
 * Files that fail to download (network error or non-OK response) are skipped
 * and counted as failures; only successfully fetched files are added to the
 * ZIP. Throws if NO file could be downloaded (so the caller never presents an
 * empty ZIP as success). Returns per-file stats so the caller can warn when
 * the ZIP is incomplete.
 */
async function fetchFilesIntoZip(
  entries: DownloadFileInfo[],
  zipName: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const { zipSync } = await import('fflate');

  const fileMap: Record<string, Uint8Array> = {};
  const total = entries.length;
  // Files actually added to the ZIP. Kept separate from `processed` so the
  // progress bar advances per-file while `succeeded` reflects real content.
  let succeeded = 0;
  let processed = 0;

  for (const file of entries) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new Error('Download cancelled');
    }

    // Notify progress (processed = attempted so far, success or fail)
    if (onProgress) {
      onProgress({
        current: processed,
        total,
        percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
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

      succeeded++;
    } catch (error) {
      if (signal?.aborted) {
        throw new Error('Download cancelled', { cause: error });
      }
      logger.error('Error downloading file %s:', file.relativePath, error);
      // Skip and continue on error (counted as a failure, not added to ZIP)
    } finally {
      processed++;
    }
  }

  // If nothing could be downloaded, do not present an empty ZIP as success.
  if (succeeded === 0) {
    throw new Error('Failed to download any files');
  }

  // Notify final progress
  if (onProgress) {
    onProgress({
      current: total,
      total,
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
  anchor.download = `${zipName}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);

  return { total, succeeded, failed: total - succeeded };
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
): Promise<DownloadResult> {
  // Get file info for the folder
  const downloadInfo = await getFolderDownloadInfo(folderPath);

  if (downloadInfo.fileCount === 0) {
    throw new Error('Folder is empty');
  }

  return fetchFilesIntoZip(downloadInfo.files, folderName, onProgress, signal);
}

/**
 * Download multiple selected items (files and/or folders) as a single ZIP.
 * Folder contents are nested under the folder name to preserve structure.
 * @param items Selected items to bundle
 * @param zipName Base name for the resulting ZIP file (without extension)
 */
export async function downloadItems(
  items: StorageItem[],
  zipName: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  if (items.length === 0) {
    throw new Error('No items selected');
  }

  // Collect ZIP entries from all selected items
  const entries: DownloadFileInfo[] = [];

  for (const item of items) {
    if (signal?.aborted) {
      throw new Error('Download cancelled');
    }

    if (item.type === 'file') {
      const downloadUrl = await generateDownloadUrl(item.path);
      entries.push({ relativePath: item.name, downloadUrl, size: item.size ?? 0 });
    } else {
      // Folder: fetch its file list and nest under the folder name
      const downloadInfo = await getFolderDownloadInfo(item.path);
      for (const file of downloadInfo.files) {
        entries.push({
          ...file,
          relativePath: `${item.name}/${file.relativePath}`,
        });
      }
    }
  }

  if (entries.length === 0) {
    throw new Error('Folder is empty');
  }

  return fetchFilesIntoZip(entries, zipName, onProgress, signal);
}
