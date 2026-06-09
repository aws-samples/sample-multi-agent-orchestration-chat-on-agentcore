/**
 * S3 List Files Tool - Retrieve user storage file list
 */

import { s3ListFilesDefinition } from '@moca/tool-definitions';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { createUserScopedS3Client } from '../../../libs/utils/scoped-credentials.js';
import {
  defineTool,
  requireUserId,
  requireIdentityId,
  requireStoragePath,
} from '../_shared/index.js';
import { getUserStoragePrefix, isPathWithinAllowedScope, normalizePath } from './path-scope.js';
import { formatExpiryTime, formatFileSize, formatRelativeTime } from './format.js';

/**
 * Generate presigned URL for S3 object.
 *
 * Impure: needs the live S3 client and the request-presigner signer, so it
 * stays in the tool file rather than a pure helper module.
 */
async function generatePresignedUrl(
  client: S3Client,
  bucketName: string,
  key: string,
  expiresIn: number
): Promise<string> {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    const url = await getSignedUrl(client, command, { expiresIn });
    return url;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[S3_LIST] Failed to generate presigned URL for ${key}: ${errorMessage}`);
    throw error;
  }
}

/**
 * S3 List Files Tool
 *
 * Authentication and identity resolution are delegated to the `_shared`
 * `requireUserId` / `requireIdentityId` helpers; their `ToolContextError`
 * messages are surfaced verbatim by `defineTool`. Recoverable storage
 * conditions (missing bucket config, scope violation, client init failure,
 * listing failure) return guidance strings directly.
 */
export const s3ListFilesTool = defineTool(s3ListFilesDefinition, async (input) => {
  const { path, recursive, maxResults, includePresignedUrls, presignedUrlExpiry } = input;

  // Get user ID and storage path from request context
  const userId = requireUserId();
  const allowedStoragePath = requireStoragePath();
  const bucketName = config.USER_STORAGE_BUCKET_NAME;

  if (!bucketName) {
    logger.error('[S3_LIST] Bucket name not configured');
    return 'Error: Storage configuration incomplete (USER_STORAGE_BUCKET_NAME not set)';
  }

  // Path processing: use allowedStoragePath if empty or root
  let normalizedPath = normalizePath(path);
  const normalizedAllowedPath = normalizePath(allowedStoragePath);

  // Redirect to allowed path if input path is empty or root
  if (!normalizedPath || normalizedPath === '/' || normalizedPath === '') {
    normalizedPath = normalizedAllowedPath;
  }

  // Verify path access permissions
  if (!isPathWithinAllowedScope(normalizedPath, allowedStoragePath)) {
    logger.warn(
      `[S3_LIST] Access denied: user=${userId}, requestPath=${path}, allowedPath=${allowedStoragePath}`
    );
    return `Access denied: The specified path "${path}" is outside the permitted directory ("${allowedStoragePath}").\n\nPlease specify a path under the allowed directory.`;
  }

  // Resolve storage key: always use Identity Pool identityId (format: "REGION:uuid").
  // Populated by `identityResolverMiddleware` earlier in the request chain.
  const storageKey = requireIdentityId();

  // Build prefix (considering allowed storage path)
  const basePrefix = normalizedAllowedPath
    ? `${getUserStoragePrefix(storageKey)}/${normalizedAllowedPath}`
    : getUserStoragePrefix(storageKey);

  const prefix =
    normalizedPath && normalizedPath !== normalizedAllowedPath
      ? `${basePrefix}/${normalizedPath.replace(normalizedAllowedPath + '/', '')}/`
      : `${basePrefix}${basePrefix.endsWith('/') ? '' : '/'}`;

  logger.info(
    `[S3_LIST] File list retrieval: user=${userId}, path=${path}, allowedPath=${allowedStoragePath}, recursive=${recursive}`
  );

  // Create user-scoped S3 client
  let s3Client: S3Client;
  try {
    s3Client = await createUserScopedS3Client(userId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[S3_LIST] Failed to create scoped S3 client: ${errorMessage}`);
    return `Error: Failed to initialize storage client: ${errorMessage}`;
  }

  try {
    const items: Array<{
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
      lastModified?: Date;
      s3Key?: string;
      presignedUrl?: string;
    }> = [];

    if (recursive) {
      // Recursive retrieval
      let continuationToken: string | undefined;
      let totalFetched = 0;

      do {
        const command = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          MaxKeys: Math.min(1000, maxResults - totalFetched),
          ContinuationToken: continuationToken,
        });

        const response = await s3Client.send(command);

        if (response.Contents) {
          for (const content of response.Contents) {
            if (content.Key && content.Key !== prefix) {
              const relativePath = content.Key.replace(prefix, '');
              items.push({
                name: relativePath.split('/').pop() || relativePath,
                path: `/${normalizedPath}/${relativePath}`.replace(/\/+/g, '/'),
                type: content.Key.endsWith('/') ? 'directory' : 'file',
                size: content.Size,
                lastModified: content.LastModified,
                s3Key: content.Key,
              });
              totalFetched++;

              if (totalFetched >= maxResults) break;
            }
          }
        }

        continuationToken = response.NextContinuationToken;

        if (totalFetched >= maxResults) break;
      } while (continuationToken);
    } else {
      // Non-recursive retrieval (current directory only)
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        Delimiter: '/',
        MaxKeys: maxResults,
      });

      const response = await s3Client.send(command);

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
              lastModified: content.LastModified,
              s3Key: content.Key,
            });
          }
        }
      }
    }

    // Generate presigned URLs if requested
    if (includePresignedUrls) {
      logger.info(
        `[S3_LIST] Generating presigned URLs for ${items.filter((i) => i.type === 'file').length} files (expiry: ${presignedUrlExpiry}s)`
      );

      for (const item of items) {
        if (item.type === 'file' && item.s3Key) {
          try {
            item.presignedUrl = await generatePresignedUrl(
              s3Client,
              bucketName,
              item.s3Key,
              presignedUrlExpiry
            );
          } catch (error) {
            logger.warn(`[S3_LIST] Skipping presigned URL for ${item.name}: ${error}`);
            // Continue with other files even if one fails
          }
        }
      }

      logger.info('[S3_LIST] Presigned URL generation complete');
    }

    // Format results
    if (items.length === 0) {
      return `Directory is empty\nPath: ${path}\n\nNo files or directories found.`;
    }

    let output = `S3 Storage - File List\n`;
    output += `Path: ${path}\n`;
    output += `Bucket: ${bucketName}\n`;
    output += `Prefix: ${prefix}\n`;
    output += `Mode: ${recursive ? 'Recursive' : 'Current directory only'}\n`;
    output += `Total: ${items.length} items\n`;
    if (includePresignedUrls) {
      output += `Presigned URLs: Enabled (expires in ${formatExpiryTime(presignedUrlExpiry)})\n`;
    }
    output += `\n`;

    // Separate and sort directories and files
    const directories = items.filter((item) => item.type === 'directory');
    const files = items.filter((item) => item.type === 'file');

    // Directory list
    if (directories.length > 0) {
      output += `Directories (${directories.length}):\n`;
      directories.forEach((dir) => {
        output += `  - ${dir.name}/\n`;
        output += `    Path: ${dir.path}\n`;
      });
      output += `\n`;
    }

    // File list
    if (files.length > 0) {
      output += `Files (${files.length}):\n`;
      files.forEach((file) => {
        output += `  - ${file.name}\n`;
        output += `    Path: ${file.path}\n`;
        if (file.size !== undefined) {
          output += `    Size: ${formatFileSize(file.size)}\n`;
        }
        if (file.lastModified) {
          output += `    Modified: ${formatRelativeTime(file.lastModified)} (${file.lastModified.toISOString()})\n`;
        }
        if (file.presignedUrl) {
          output += `    URL: ${file.presignedUrl}\n`;
        }
      });
    }

    logger.info(
      `[S3_LIST] File list retrieval complete: ${items.length} items (directories: ${directories.length}, files: ${files.length})`
    );

    return output.trim();
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[S3_LIST] File list retrieval error: ${errorMessage}`);

    return `Error occurred while retrieving file list
Path: ${path}
Error: ${errorMessage}

Possible causes:
1. The specified path does not exist
2. No access permission to S3 bucket
3. Network connection problem
4. AWS credentials issue`;
  }
});
