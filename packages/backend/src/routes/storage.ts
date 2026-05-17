/**
 * Storage Routes
 * API for user file storage
 *
 * All storage operations use `storageKey` (= identityId when Identity Pool is configured,
 * userId fallback for local dev) to align with the IAM policy variable
 * ${cognito-identity.amazonaws.com:sub} enforced by the S3 bucket policy.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.js';
import * as storageService from '../services/s3-storage.js';
import { logger } from '../libs/logger/index.js';

const router = Router();

// Apply JWT authentication to all routes

/**
 * GET /storage/list
 * Get list of files and folders in a directory
 */
router.get('/list', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const path = (req.query.path as string) || '/';

    const result = await storageService.listStorageItems(storageKey, path);

    res.status(200).json(result);
  } catch (error) {
    logger.error({ err: error }, 'Storage list error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to list storage items',
    });
  }
});

/**
 * GET /storage/size
 * Recursively calculate the total size of all files in a directory
 */
router.get('/size', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const path = (req.query.path as string) || '/';

    const result = await storageService.getDirectorySize(storageKey, path);

    res.status(200).json(result);
  } catch (error) {
    logger.error({ err: error }, 'Storage size calculation error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to calculate directory size',
    });
  }
});

/**
 * POST /storage/upload
 * Generate a pre-signed URL for file upload
 */
router.post('/upload', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const { fileName, path, contentType } = req.body;

    if (!fileName) {
      return res.status(400).json({ error: 'Bad Request', message: 'fileName is required' });
    }

    const result = await storageService.generateUploadUrl(storageKey, fileName, path, contentType);

    res.status(200).json(result);
  } catch (error) {
    logger.error({ err: error }, 'Storage upload URL generation error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to generate upload URL',
    });
  }
});

/**
 * POST /storage/directory
 * Create a new directory
 */
router.post('/directory', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const { directoryName, path } = req.body;

    if (!directoryName) {
      return res.status(400).json({ error: 'Bad Request', message: 'directoryName is required' });
    }

    // Reject path traversal characters to prevent directory traversal attacks
    if (
      /(\.\.[/\\])|(^\.\.$)|(^\.\.\/)|([/\\]\.\.$)/.test(directoryName) ||
      directoryName.includes('\0')
    ) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid directory name' });
    }

    const result = await storageService.createDirectory(storageKey, directoryName, path);

    res.status(201).json(result);
  } catch (error) {
    logger.error({ err: error }, 'Storage directory creation error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to create directory',
    });
  }
});

/**
 * DELETE /storage/file
 * Delete a file
 */
router.delete('/file', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: 'Bad Request', message: 'path is required' });
    }

    const result = await storageService.deleteFile(storageKey, path);

    res.status(200).json(result);
  } catch (error) {
    logger.error({ err: error }, 'Storage file deletion error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to delete file',
    });
  }
});

/**
 * DELETE /storage/directory
 * Delete a directory
 * With query parameter force=true, deletes all files within the directory as well
 */
router.delete('/directory', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const path = req.query.path as string;
    const force = req.query.force === 'true';

    if (!path) {
      return res.status(400).json({ error: 'Bad Request', message: 'path is required' });
    }

    const result = await storageService.deleteDirectory(storageKey, path, force);

    res.status(200).json(result);
  } catch (error) {
    logger.error({ err: error }, 'Storage directory deletion error:');

    if (error instanceof Error && error.message === 'Directory is not empty') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Directory is not empty',
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to delete directory',
    });
  }
});

/**
 * GET /storage/download
 * Generate a pre-signed URL for file download
 */
router.get('/download', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: 'Bad Request', message: 'path is required' });
    }

    const downloadUrl = await storageService.generateDownloadUrl(storageKey, path);

    res.status(200).json({ downloadUrl });
  } catch (error) {
    logger.error({ err: error }, 'Storage download URL generation error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to generate download URL',
    });
  }
});

/**
 * GET /storage/tree
 * Get folder tree structure
 */
router.get('/tree', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const tree = await storageService.getFolderTree(storageKey);

    res.status(200).json({ tree });
  } catch (error) {
    logger.error({ err: error }, 'Storage tree generation error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to generate folder tree',
    });
  }
});

/**
 * GET /storage/download-folder
 * Get pre-signed URLs for all files in a folder (for ZIP creation)
 */
router.get('/download-folder', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const storageKey = req.identityId!;

    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: 'Bad Request', message: 'path is required' });
    }

    const downloadInfo = await storageService.getRecursiveDownloadUrls(storageKey, path);

    // Check 1GB limit
    const maxSize = 1024 * 1024 * 1024; // 1GB
    if (downloadInfo.totalSize > maxSize) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Folder size (${Math.round(downloadInfo.totalSize / 1024 / 1024)}MB) exceeds 1GB limit`,
        totalSize: downloadInfo.totalSize,
        fileCount: downloadInfo.fileCount,
      });
    }

    res.status(200).json(downloadInfo);
  } catch (error) {
    logger.error({ err: error }, 'Storage folder download error:');
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to get folder download URLs',
    });
  }
});

export default router;
