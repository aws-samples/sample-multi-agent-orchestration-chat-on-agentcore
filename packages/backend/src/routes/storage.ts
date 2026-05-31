/**
 * Storage Routes
 * API for user file storage
 *
 * All storage operations use `storageKey` (= identityId when Identity Pool is configured,
 * userId fallback for local dev) to align with the IAM policy variable
 * ${cognito-identity.amazonaws.com:sub} enforced by the S3 bucket policy.
 *
 * Handlers are wrapped in `asyncHandler` and signal failures by throwing
 * `AppError`; the global `errorHandlerMiddleware` renders the canonical error
 * envelope. No per-handler try/catch.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import * as storageService from '../services/s3-storage.js';
import { AppError, ErrorCode, ok } from '../libs/http/index.js';

const router = Router();

// Apply JWT authentication to all routes

/**
 * GET /storage/list
 * Get list of files and folders in a directory
 */
router.get(
  '/list',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const path = (req.query.path as string) || '/';

    const result = await storageService.listStorageItems(storageKey, path);

    res.status(200).json(ok(req, result as unknown as Record<string, unknown>));
  })
);

/**
 * GET /storage/size
 * Recursively calculate the total size of all files in a directory
 */
router.get(
  '/size',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const path = (req.query.path as string) || '/';

    const result = await storageService.getDirectorySize(storageKey, path);

    res.status(200).json(ok(req, result as Record<string, unknown>));
  })
);

/**
 * POST /storage/upload
 * Generate a pre-signed URL for file upload
 */
router.post(
  '/upload',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const { fileName, path, contentType } = req.body;

    if (!fileName) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'fileName is required');
    }

    const result = await storageService.generateUploadUrl(storageKey, fileName, path, contentType);

    res.status(200).json(ok(req, result as unknown as Record<string, unknown>));
  })
);

/**
 * POST /storage/directory
 * Create a new directory
 */
router.post(
  '/directory',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const { directoryName, path } = req.body;

    if (!directoryName) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'directoryName is required');
    }

    // Reject path traversal characters to prevent directory traversal attacks
    if (
      /(\.\.[/\\])|(^\.\.$)|(^\.\.\/)|([/\\]\.\.$)/.test(directoryName) ||
      directoryName.includes('\0')
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid directory name');
    }

    const result = await storageService.createDirectory(storageKey, directoryName, path);

    res.status(201).json(ok(req, result as Record<string, unknown>));
  })
);

/**
 * DELETE /storage/file
 * Delete a file
 */
router.delete(
  '/file',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const path = req.query.path as string;

    if (!path) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'path is required');
    }

    const result = await storageService.deleteFile(storageKey, path);

    res.status(200).json(ok(req, result as Record<string, unknown>));
  })
);

/**
 * DELETE /storage/directory
 * Delete a directory
 * With query parameter force=true, deletes all files within the directory as well
 */
router.delete(
  '/directory',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const path = req.query.path as string;
    const force = req.query.force === 'true';

    if (!path) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'path is required');
    }

    let result;
    try {
      result = await storageService.deleteDirectory(storageKey, path, force);
    } catch (e) {
      if (e instanceof Error && e.message === 'Directory is not empty') {
        throw new AppError(ErrorCode.CONFLICT, 'Directory is not empty');
      }
      throw e;
    }

    res.status(200).json(ok(req, result as Record<string, unknown>));
  })
);

/**
 * GET /storage/download
 * Generate a pre-signed URL for file download
 */
router.get(
  '/download',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const path = req.query.path as string;

    if (!path) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'path is required');
    }

    const downloadUrl = await storageService.generateDownloadUrl(storageKey, path);

    res.status(200).json(ok(req, { downloadUrl }));
  })
);

/**
 * GET /storage/tree
 * Get folder tree structure
 */
router.get(
  '/tree',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const tree = await storageService.getFolderTree(storageKey);

    res.status(200).json(ok(req, { tree }));
  })
);

/**
 * GET /storage/download-folder
 * Get pre-signed URLs for all files in a folder (for ZIP creation)
 */
router.get(
  '/download-folder',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const storageKey = req.identityId!;

    const path = req.query.path as string;

    if (!path) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'path is required');
    }

    const downloadInfo = await storageService.getRecursiveDownloadUrls(storageKey, path);

    // Check 1GB limit
    const maxSize = 1024 * 1024 * 1024; // 1GB
    if (downloadInfo.totalSize > maxSize) {
      throw new AppError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `Folder size (${Math.round(downloadInfo.totalSize / 1024 / 1024)}MB) exceeds 1GB limit`,
        {
          details: {
            totalSize: downloadInfo.totalSize,
            fileCount: downloadInfo.fileCount,
          },
        }
      );
    }

    res.status(200).json(ok(req, downloadInfo as unknown as Record<string, unknown>));
  })
);

export default router;
