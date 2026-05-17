/**
 * S3 Storage Service
 * Provides per-user file storage
 */

import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { IdentityId } from '@moca/core';
import { config } from '../config/index.js';
import { createScopedS3Client } from '../libs/auth/scoped-credentials.js';
import { logger } from '../libs/logger/index.js';

const defaultS3Client = new S3Client({ region: config.AWS_REGION });

/**
 * Get an S3 client scoped to the given user.
 * storageKey is the Cognito Identity Pool identityId — the only value that
 * matches both the S3 prefix convention (`users/{identityId}/`) and the session
 * policy built by `createScopedS3Client`.
 */
async function getS3Client(storageKey: string): Promise<S3Client> {
  if (config.USER_SCOPED_ROLE_ARN) {
    return createScopedS3Client(storageKey as IdentityId);
  }
  return defaultS3Client;
}

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
  totalSize?: number;
  fileCount?: number;
}

export interface UploadUrlResponse {
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

/**
 * Generate storage path prefix for a user.
 * Uses identityId (Identity Pool sub) as the key to align with the IAM policy
 * variable ${cognito-identity.amazonaws.com:sub} used in the Authenticated Role.
 */
function getUserStoragePrefix(storageKey: string): string {
  return `users/${storageKey}`;
}

/**
 * Normalize path (remove leading/trailing slashes, strip local workspace path prefix, guard against double-encoding)
 * AI-generated text may or may not be URL-encoded, so double-encoding protection is included
 */
function normalizePath(path: string): string {
  let normalized = path;

  // 1. Guard against double-encoding (decode up to 2 times)
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) {
        // Cannot decode further
        break;
      }
      normalized = decoded;
    } catch {
      // Use current value if decoding fails
      break;
    }
  }

  // 2. Remove leading and trailing slashes
  normalized = normalized.replace(/^\/+|\/+$/g, '');

  // 3. Remove local workspace path prefix (to guard against hallucinations)
  // Strip prefixes like /tmp/ws/, tmp/ws/, /tmp/, tmp/
  normalized = normalized.replace(/^(?:tmp\/ws|tmp)\//, '');

  return normalized;
}

/**
 * List directory contents
 */
export async function listStorageItems(
  storageKey: string,
  path: string = '/'
): Promise<ListStorageResponse> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(path);
  const prefix = normalizedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedPath}/`
    : `${getUserStoragePrefix(storageKey)}/`;

  logger.info(`Listing storage items for user ${storageKey} at path: ${path} (prefix: ${prefix})`);

  const s3Client = await getS3Client(storageKey);
  const command = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
    Delimiter: '/',
  });

  const response = await s3Client.send(command);
  const items: StorageItem[] = [];

  // Add directories
  if (response.CommonPrefixes) {
    for (const commonPrefix of response.CommonPrefixes) {
      if (commonPrefix.Prefix) {
        const name = commonPrefix.Prefix.replace(prefix, '').replace(/\/$/, '');
        items.push({
          name,
          path: `/${normalizedPath}/${name}`.replace(/\/+/g, '/'),
          type: 'directory',
        });
      }
    }
  }

  // Add files
  if (response.Contents) {
    for (const content of response.Contents) {
      if (content.Key && content.Key !== prefix) {
        const name = content.Key.replace(prefix, '');
        items.push({
          name,
          path: `/${normalizedPath}/${name}`.replace(/\/+/g, '/'),
          type: 'file',
          size: content.Size,
          lastModified: content.LastModified?.toISOString(),
        });
      }
    }
  }

  logger.info(`Found ${items.length} items`);

  return {
    items,
    path: `/${normalizedPath}`,
  };
}

/**
 * Recursively calculate the total size of all files in a directory
 */
export async function getDirectorySize(
  storageKey: string,
  path: string = '/'
): Promise<{ totalSize: number; fileCount: number }> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(path);
  const prefix = normalizedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedPath}/`
    : `${getUserStoragePrefix(storageKey)}/`;

  logger.info(`Calculating directory size for: ${prefix}`);

  const s3Client = await getS3Client(storageKey);
  let totalSize = 0;
  let fileCount = 0;
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);

    if (response.Contents) {
      for (const content of response.Contents) {
        if (content.Key && !content.Key.endsWith('/')) {
          totalSize += content.Size || 0;
          fileCount++;
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  logger.info(`Directory size: ${totalSize} bytes, ${fileCount} files`);

  return { totalSize, fileCount };
}

/**
 * Generate a pre-signed URL for file upload
 */
export async function generateUploadUrl(
  storageKey: string,
  fileName: string,
  path: string = '/',
  contentType?: string
): Promise<UploadUrlResponse> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(path);
  const key = normalizedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedPath}/${fileName}`
    : `${getUserStoragePrefix(storageKey)}/${fileName}`;

  logger.info(`Generating upload URL for: ${key}`);

  // Note: File size limit is 5MB (based on Bedrock Converse API constraint)
  // Reference this if adding validation on client or server side in the future
  // const maxFileSize = 5 * 1024 * 1024; // 5MB in bytes

  const s3Client = await getS3Client(storageKey);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  const expiresIn = 3600; // 1 hour
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

  logger.info(`Upload URL generated (expires in ${expiresIn}s)`);

  return {
    uploadUrl,
    key,
    expiresIn,
  };
}

/**
 * Create a directory
 * Since S3 has no concept of directories, create an empty placeholder object
 */
export async function createDirectory(
  storageKey: string,
  directoryName: string,
  path: string = '/'
) {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(path);
  const key = normalizedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedPath}/${directoryName}/`
    : `${getUserStoragePrefix(storageKey)}/${directoryName}/`;

  logger.info(`Creating directory: ${key}`);

  const s3Client = await getS3Client(storageKey);
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: '',
  });

  await s3Client.send(command);

  logger.info(`Directory created: ${key}`);

  return {
    path: `/${normalizedPath}/${directoryName}`.replace(/\/+/g, '/'),
    name: directoryName,
  };
}

/**
 * Delete a file
 */
export async function deleteFile(storageKey: string, filePath: string) {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(filePath);
  const key = `${getUserStoragePrefix(storageKey)}/${normalizedPath}`;

  logger.info(`Deleting file: ${key}`);

  const s3Client = await getS3Client(storageKey);
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  await s3Client.send(command);

  logger.info(`File deleted: ${key}`);

  return { deleted: true };
}

/**
 * Delete a directory
 * @param force If true, recursively delete all objects within the directory
 */
export async function deleteDirectory(
  storageKey: string,
  directoryPath: string,
  force: boolean = false
) {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(directoryPath);
  // Build prefix correctly even for root folder
  const prefix = normalizedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedPath}/`
    : `${getUserStoragePrefix(storageKey)}/`;

  logger.info(`Deleting directory: ${prefix} (force: ${force})`);

  const s3Client = await getS3Client(storageKey);

  // Check objects in directory
  const listCommand = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
  });

  const listResponse = await s3Client.send(listCommand);

  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    throw new Error('Directory not found');
  }

  // Directory can be deleted if it only contains the placeholder object
  if (listResponse.Contents.length === 1 && listResponse.Contents[0].Key === prefix) {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: prefix,
    });

    await s3Client.send(deleteCommand);
    logger.info(`Directory deleted: ${prefix}`);
    return { deleted: true, count: 1 };
  }

  // If force flag is not set, non-empty directories cannot be deleted
  if (!force) {
    throw new Error('Directory is not empty');
  }

  // If force flag is set, delete all objects
  let deletedCount = 0;
  let continuationToken: string | undefined;

  do {
    // Get object list (with pagination support)
    const listCmd = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000, // Maximum value for S3 API
    });

    const response = await s3Client.send(listCmd);

    if (response.Contents && response.Contents.length > 0) {
      // Build key list for batch deletion
      const objectsToDelete = response.Contents.map((obj) => ({ Key: obj.Key! }));

      // Bulk delete using DeleteObjectsCommand
      const { DeleteObjectsCommand: BatchDeleteCommand } = await import('@aws-sdk/client-s3');
      const deleteCmd = new BatchDeleteCommand({
        Bucket: bucketName,
        Delete: {
          Objects: objectsToDelete,
          Quiet: true,
        },
      });

      await s3Client.send(deleteCmd);
      deletedCount += objectsToDelete.length;
      logger.info(`Deleted ${objectsToDelete.length} objects (total: ${deletedCount})`);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  logger.info(`Directory and all contents deleted: ${prefix} (${deletedCount} objects)`);

  return { deleted: true, count: deletedCount };
}

/**
 * Generate a pre-signed URL for file download
 */
export async function generateDownloadUrl(storageKey: string, filePath: string): Promise<string> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(filePath);
  const key = `${getUserStoragePrefix(storageKey)}/${normalizedPath}`;

  logger.info(`Generating download URL for: ${key}`);

  const s3Client = await getS3Client(storageKey);
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  const expiresIn = 3600; // 1 hour
  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });

  logger.info(`Download URL generated`);

  return downloadUrl;
}

/**
 * Check if a file exists
 */
export async function checkFileExists(storageKey: string, filePath: string): Promise<boolean> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(filePath);
  const key = `${getUserStoragePrefix(storageKey)}/${normalizedPath}`;

  try {
    const s3Client = await getS3Client(storageKey);
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await s3Client.send(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * File information for folder download
 */
export interface DownloadFileInfo {
  relativePath: string; // Relative path within the ZIP
  downloadUrl: string; // S3 pre-signed URL
  size: number; // File size
}

export interface FolderDownloadInfo {
  files: DownloadFileInfo[];
  totalSize: number;
  fileCount: number;
}

/**
 * Folder tree structure
 */
export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
}

/**
 * Get folder tree
 * Returns all folders from root in hierarchical structure
 */
export async function getFolderTree(storageKey: string): Promise<FolderNode[]> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const prefix = `${getUserStoragePrefix(storageKey)}/`;
  logger.info(`Building folder tree for user ${storageKey} (prefix: ${prefix})`);

  const s3Client = await getS3Client(storageKey);

  // Retrieve all objects (including directory markers)
  const allObjects: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Key !== prefix) {
          // Get relative path excluding prefix
          const relativePath = obj.Key.replace(prefix, '');
          allObjects.push(relativePath);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  // Extract directory paths (deduplicate)
  const dirPaths = new Set<string>();
  for (const objPath of allObjects) {
    const parts = objPath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += (currentPath ? '/' : '') + parts[i];
      dirPaths.add(currentPath);
    }
  }

  // Sort directory paths
  const sortedDirPaths = Array.from(dirPaths).sort();

  // Build tree structure
  const root: FolderNode = {
    path: '/',
    name: 'Root',
    children: [],
  };

  const pathMap = new Map<string, FolderNode>();
  pathMap.set('/', root);

  for (const dirPath of sortedDirPaths) {
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const fullPath = `/${dirPath}`;

    const node: FolderNode = {
      path: fullPath,
      name,
      children: [],
    };

    pathMap.set(fullPath, node);

    // Find parent node and add to it
    const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/';
    const parentNode = pathMap.get(parentPath);
    if (parentNode) {
      parentNode.children.push(node);
    }
  }

  logger.info(`Folder tree built with ${sortedDirPaths.length} directories`);

  return [root];
}

/**
 * Get pre-signed URLs for all files in a folder (recursively)
 */
export async function getRecursiveDownloadUrls(
  storageKey: string,
  folderPath: string
): Promise<FolderDownloadInfo> {
  const bucketName = config.USER_STORAGE_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('USER_STORAGE_BUCKET_NAME is not configured');
  }

  const normalizedPath = normalizePath(folderPath);
  const prefix = normalizedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedPath}/`
    : `${getUserStoragePrefix(storageKey)}/`;

  logger.info(`Getting recursive download URLs for folder: ${prefix}`);

  const s3Client = await getS3Client(storageKey);
  const files: DownloadFileInfo[] = [];
  let totalSize = 0;
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });

    const response = await s3Client.send(command);

    if (response.Contents) {
      for (const obj of response.Contents) {
        // Skip directory markers (objects ending with /)
        if (obj.Key && !obj.Key.endsWith('/') && obj.Key !== prefix) {
          const relativePath = obj.Key.replace(prefix, '');
          const size = obj.Size || 0;

          // Generate pre-signed URL
          const downloadCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: obj.Key,
          });

          const downloadUrl = await getSignedUrl(s3Client, downloadCommand, { expiresIn: 3600 });

          files.push({
            relativePath,
            downloadUrl,
            size,
          });

          totalSize += size;
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  logger.info(`Found ${files.length} files (total size: ${totalSize} bytes)`);

  return {
    files,
    totalSize,
    fileCount: files.length,
  };
}
