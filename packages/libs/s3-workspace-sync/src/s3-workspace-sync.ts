import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { EventEmitter } from 'events';
import pLimit from 'p-limit';

import type {
  S3WorkspaceSyncOptions,
  FileInfo,
  SyncResult,
  SyncProgress,
  SyncLogger,
} from './types.js';
import { SyncIgnoreFilter } from './sync-ignore-filter.js';
import { guessContentType } from './content-type.js';
import { calculateFileHash } from './utils/hash.js';
import { createDefaultLogger } from './logger.js';
import { S3OperationError } from './errors.js';

// 50 matches the AWS SDK v3 NodeHttpHandler default maxSockets per origin.
// Raising this above 50 gains nothing unless the HTTP connection pool is also enlarged —
// extra p-limit slots would just queue behind the socket pool, wasting memory.
const DEFAULT_DOWNLOAD_CONCURRENCY = 50;

// Kept well below the download limit because each upload calls fs.readFileSync(),
// holding the entire file in memory until the PUT completes.
// Lower concurrency also reduces the risk of S3 per-prefix write throttling (503 SlowDown).
const DEFAULT_UPLOAD_CONCURRENCY = 10;

/**
 * Bidirectional file synchronizer between Amazon S3 and a local workspace directory.
 *
 * Features:
 * - **pull()** — Download from S3 to local (S3 as source of truth).
 *   Deletes local-only files that no longer exist on S3.
 * - **push()** — Upload local changes to S3 using MD5-hash-based diff detection.
 *   Only changed or new files are transferred.
 * - **Background pull** — `startBackgroundPull()` initiates a non-blocking pull
 *   that can be awaited later with `waitForPull()`.
 * - **`.syncignore`** — `.gitignore`-style pattern file for excluding paths.
 * - **Concurrent transfers** — Configurable concurrency via `p-limit`.
 * - **Progress events** — Emits `'progress'` events with {@link SyncProgress} payloads.
 *
 * @example
 * ```typescript
 * import { S3WorkspaceSync } from '@moca/s3-workspace-sync';
 *
 * const sync = new S3WorkspaceSync({
 *   bucket: 'my-bucket',
 *   prefix: 'users/user123/workspace/',
 *   workspaceDir: '/tmp/ws',
 * });
 *
 * await sync.pull();
 * // ... agent performs file operations ...
 * const result = await sync.push();
 * console.log(`Uploaded ${result.uploadedFiles} files`);
 * ```
 */
export class S3WorkspaceSync extends EventEmitter {
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly workspaceDir: string;
  private readonly downloadConcurrency: number;
  private readonly uploadConcurrency: number;
  private readonly logger: SyncLogger;
  private readonly ignoreFilter: SyncIgnoreFilter;
  private readonly contentTypeResolver: (filename: string) => string;

  private fileSnapshot: Map<string, FileInfo> = new Map();
  private pullPromise: Promise<void> | null = null;
  private pullComplete = false;

  constructor(options: S3WorkspaceSyncOptions) {
    super();

    if (!options.bucket) throw new Error('options.bucket is required');
    if (!options.prefix) throw new Error('options.prefix is required');
    if (!options.workspaceDir) throw new Error('options.workspaceDir is required');

    this.bucket = options.bucket;
    this.prefix = options.prefix.endsWith('/') ? options.prefix : `${options.prefix}/`;
    this.workspaceDir = options.workspaceDir;
    this.downloadConcurrency = options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;
    this.uploadConcurrency = options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
    this.logger = options.logger ?? createDefaultLogger();
    this.contentTypeResolver = options.contentTypeResolver ?? guessContentType;

    this.s3Client =
      options.s3Client ??
      new S3Client({
        region: options.region ?? process.env.AWS_REGION ?? 'us-east-1',
      });

    this.ignoreFilter = new SyncIgnoreFilter(this.logger, options.ignorePatterns);

    this.logger.debug(
      `Initialized: bucket=${this.bucket}, prefix=${this.prefix}, dir=${this.workspaceDir}`
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Download all files from S3 to the local workspace directory.
   * S3 is treated as the source of truth — local-only files are deleted.
   */
  async pull(): Promise<SyncResult> {
    const startTime = Date.now();
    let downloadedFiles = 0;
    const errors: string[] = [];
    const s3FilePaths = new Set<string>();

    try {
      this.logger.debug(`Pulling from s3://${this.bucket}/${this.prefix}`);
      this.ensureDirectoryExists(this.workspaceDir);

      // Phase 1: List all S3 objects and build download tasks
      interface DownloadTask {
        s3Key: string;
        relativePath: string;
        localPath: string;
      }
      const downloadTasks: DownloadTask[] = [];
      let continuationToken: string | undefined;

      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        });

        const listResponse = await this.s3Client.send(listCommand);

        if (listResponse.Contents) {
          for (const item of listResponse.Contents) {
            if (!item.Key || item.Key === this.prefix || item.Key.endsWith('/')) {
              continue;
            }

            const relativePath = item.Key.replace(this.prefix, '');

            if (this.ignoreFilter.isIgnored(relativePath)) {
              this.logger.debug(`Skipping ignored file: ${relativePath}`);
              continue;
            }

            s3FilePaths.add(relativePath);

            downloadTasks.push({
              s3Key: item.Key,
              relativePath,
              localPath: path.join(this.workspaceDir, relativePath),
            });
          }
        }

        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);

      this.logger.info(
        `Found ${downloadTasks.length} files to download (concurrency: ${this.downloadConcurrency})`
      );

      // Phase 2: Parallel download
      const limit = pLimit(this.downloadConcurrency);
      let completedCount = 0;
      const progressInterval = Math.max(1, Math.floor(downloadTasks.length / 20));

      const downloadPromises = downloadTasks.map((task) =>
        limit(async () => {
          try {
            await this.downloadFile(task.s3Key, task.localPath);

            const stats = fs.statSync(task.localPath);
            const hash = await calculateFileHash(task.localPath);
            this.fileSnapshot.set(task.relativePath, {
              path: task.relativePath,
              size: stats.size,
              mtime: stats.mtimeMs,
              hash,
            });

            downloadedFiles++;
            completedCount++;

            // Progress is only surfaced via the event emitter (UI / metrics).
            // Per-file progress logs were removed because they produced 20+
            // noisy CloudWatch entries per request for large workspaces.
            if (downloadTasks.length > 100 && completedCount % progressInterval === 0) {
              this.emitProgress(
                'download',
                completedCount,
                downloadTasks.length,
                task.relativePath
              );
            }

            return { success: true, relativePath: task.relativePath };
          } catch (error) {
            const errorMsg = `Failed to download ${task.s3Key}: ${error}`;
            this.logger.error(errorMsg);
            errors.push(errorMsg);
            completedCount++;
            return { success: false, relativePath: task.relativePath, error: errorMsg };
          }
        })
      );

      await Promise.all(downloadPromises);

      // Phase 3: Delete local-only files
      const deletedFiles = this.cleanupLocalOnlyFiles(s3FilePaths);

      // Phase 4: Load custom .syncignore from workspace (if present)
      this.ignoreFilter.loadFromWorkspace(this.workspaceDir);

      const duration = Date.now() - startTime;
      this.logger.info(
        `Pull complete: ${downloadedFiles} downloaded, ${deletedFiles} deleted in ${duration}ms`
      );

      if (errors.length > 0) {
        this.logger.warn(`Pull completed with ${errors.length} errors`);
      }

      return {
        success: errors.length === 0,
        downloadedFiles,
        deletedFiles,
        errors: errors.length > 0 ? errors : undefined,
        duration,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pull failed: ${msg}`);
      throw new S3OperationError(`Pull failed: ${msg}`, error);
    }
  }

  /**
   * Upload changed and new local files to S3 (diff-based via MD5 hash snapshot).
   * Only files whose hash differs from the last snapshot are uploaded.
   */
  async push(): Promise<SyncResult> {
    const startTime = Date.now();
    let uploadedFiles = 0;
    let deletedFiles = 0;
    const errors: string[] = [];

    try {
      await this.waitForPull();

      this.logger.info('Pushing changes to S3...');

      const currentFiles = await this.scanWorkspaceFiles();

      // Build upload task list
      interface UploadTask {
        relativePath: string;
        currentInfo: FileInfo;
        localPath: string;
        s3Key: string;
      }

      const uploadTasks: UploadTask[] = [];

      for (const [relativePath, currentInfo] of currentFiles.entries()) {
        const previousInfo = this.fileSnapshot.get(relativePath);
        const isNew = !previousInfo;
        const isModified = previousInfo && currentInfo.hash !== previousInfo.hash;

        if (isNew || isModified) {
          uploadTasks.push({
            relativePath,
            currentInfo,
            localPath: path.join(this.workspaceDir, relativePath),
            s3Key: `${this.prefix}${relativePath}`,
          });
        }
      }

      // Detect locally deleted files (in snapshot but not in current workspace)
      const deleteTasks: Array<{ relativePath: string; s3Key: string }> = [];
      for (const relativePath of this.fileSnapshot.keys()) {
        if (!currentFiles.has(relativePath)) {
          deleteTasks.push({
            relativePath,
            s3Key: `${this.prefix}${relativePath}`,
          });
        }
      }

      if (uploadTasks.length === 0 && deleteTasks.length === 0) {
        this.logger.info('No changes to push');
        return {
          success: true,
          uploadedFiles: 0,
          deletedFiles: 0,
          duration: Date.now() - startTime,
        };
      }

      // Phase 1: Upload new/modified files
      if (uploadTasks.length > 0) {
        this.logger.info(
          `Uploading ${uploadTasks.length} files (concurrency: ${this.uploadConcurrency})`
        );

        const limit = pLimit(this.uploadConcurrency);
        let completedCount = 0;
        const progressInterval = Math.max(1, Math.floor(uploadTasks.length / 20));

        const uploadPromises = uploadTasks.map((task) =>
          limit(async () => {
            try {
              await this.uploadFile(task.localPath, task.s3Key);

              this.fileSnapshot.set(task.relativePath, task.currentInfo);
              uploadedFiles++;
              completedCount++;

              if (uploadTasks.length > 20 && completedCount % progressInterval === 0) {
                const percentage = Math.round((completedCount / uploadTasks.length) * 100);
                this.logger.info(
                  `Upload progress: ${completedCount}/${uploadTasks.length} (${percentage}%)`
                );
                this.emitProgress('upload', completedCount, uploadTasks.length, task.relativePath);
              } else {
                this.logger.debug(`Uploaded: ${task.relativePath}`);
              }
            } catch (error) {
              const errorMsg = `Failed to upload ${task.relativePath}: ${error}`;
              this.logger.error(errorMsg);
              errors.push(errorMsg);
              completedCount++;
            }
          })
        );

        await Promise.all(uploadPromises);
      }

      // Phase 2: Delete S3 objects for locally removed files
      if (deleteTasks.length > 0) {
        this.logger.info(`Deleting ${deleteTasks.length} removed files from S3`);

        const limit = pLimit(this.uploadConcurrency);

        const deletePromises = deleteTasks.map((task) =>
          limit(async () => {
            try {
              await this.s3Client.send(
                new DeleteObjectCommand({ Bucket: this.bucket, Key: task.s3Key })
              );
              this.fileSnapshot.delete(task.relativePath);
              deletedFiles++;
              this.logger.debug(`Deleted from S3: ${task.relativePath}`);
            } catch (error) {
              const errorMsg = `Failed to delete ${task.relativePath}: ${error}`;
              this.logger.error(errorMsg);
              errors.push(errorMsg);
            }
          })
        );

        await Promise.all(deletePromises);
      }

      const duration = Date.now() - startTime;
      this.logger.info(
        `Push complete: ${uploadedFiles} uploaded, ${deletedFiles} deleted in ${duration}ms`
      );

      return {
        success: errors.length === 0,
        uploadedFiles,
        deletedFiles,
        errors: errors.length > 0 ? errors : undefined,
        duration,
      };
    } catch (error) {
      if (error instanceof S3OperationError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Push failed: ${msg}`);
      return {
        success: false,
        errors: [msg],
      };
    }
  }

  /**
   * Start a pull() in the background. Does not block the caller.
   * Use {@link waitForPull} to await completion when needed.
   */
  startBackgroundPull(): void {
    this.logger.debug('Starting background pull...');

    this.pullPromise = this.pull()
      .then(() => {
        this.pullComplete = true;
        // No log here: `Pull complete: N downloaded ...` is emitted by
        // the pull() call above, which is the single source of truth for
        // completion. A separate "Background pull completed" was redundant.
      })
      .catch((err) => {
        this.logger.error('Background pull failed:', err);
        this.pullComplete = true; // Mark complete even on failure so waiters unblock
      });
  }

  /**
   * Wait for the background pull started by {@link startBackgroundPull} to complete.
   * Resolves immediately if pull is already complete or was never started.
   */
  async waitForPull(): Promise<void> {
    if (this.pullComplete) return;
    if (this.pullPromise) {
      this.logger.debug('Waiting for background pull to complete...');
      await this.pullPromise;
    }
  }

  /**
   * Check whether the initial pull has completed.
   */
  isPullComplete(): boolean {
    return this.pullComplete;
  }

  /**
   * Get the workspace directory path.
   */
  getWorkspacePath(): string {
    return this.workspaceDir;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emitProgress(
    phase: SyncProgress['phase'],
    current: number,
    total: number,
    currentFile?: string
  ): void {
    const progress: SyncProgress = {
      phase,
      current,
      total,
      percentage: total > 0 ? Math.round((current / total) * 100) : 0,
      currentFile,
    };
    this.emit('progress', progress);
  }

  private async downloadFile(s3Key: string, localPath: string): Promise<void> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: s3Key });
    const response = await this.s3Client.send(command);

    if (!response.Body) {
      throw new S3OperationError(`Empty response body for ${s3Key}`);
    }

    this.ensureDirectoryExists(path.dirname(localPath));

    const writeStream = fs.createWriteStream(localPath);
    await pipeline(response.Body as NodeJS.ReadableStream, writeStream);
  }

  private async uploadFile(localPath: string, s3Key: string): Promise<void> {
    const fileContent = fs.readFileSync(localPath);
    const contentType = this.contentTypeResolver(path.basename(localPath));

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      Body: fileContent,
      ContentType: contentType,
    });

    await this.s3Client.send(command);
  }

  private async scanWorkspaceFiles(): Promise<Map<string, FileInfo>> {
    const files = new Map<string, FileInfo>();

    if (!fs.existsSync(this.workspaceDir)) {
      return files;
    }

    const scan = async (dir: string): Promise<void> => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        // nosemgrep: path-join-resolve-traversal - entry.name comes from fs.readdirSync, not user input
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile()) {
          const relativePath = path.relative(this.workspaceDir, fullPath);

          if (this.ignoreFilter.isIgnored(relativePath)) continue;

          const stats = fs.statSync(fullPath);
          const hash = await calculateFileHash(fullPath);

          files.set(relativePath, {
            path: relativePath,
            size: stats.size,
            mtime: stats.mtimeMs,
            hash,
          });
        }
      }
    };

    await scan(this.workspaceDir);
    return files;
  }

  /**
   * Delete local files that no longer exist on S3.
   * Also removes empty directories.
   */
  private cleanupLocalOnlyFiles(s3FilePaths: Set<string>): number {
    let deletedCount = 0;

    const scanDirectory = (dir: string): void => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        // nosemgrep: path-join-resolve-traversal - entry.name comes from fs.readdirSync, not user input
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(this.workspaceDir, fullPath);

        if (entry.isDirectory()) {
          scanDirectory(fullPath);

          // Remove empty directories
          try {
            const dirEntries = fs.readdirSync(fullPath);
            if (dirEntries.length === 0) {
              fs.rmdirSync(fullPath);
              this.logger.debug(`Deleted empty directory: ${relativePath}`);
            }
          } catch {
            // Ignore if directory is not empty
          }
        } else if (entry.isFile()) {
          if (this.ignoreFilter.isIgnored(relativePath)) {
            this.logger.debug(`Skipping ignored file from cleanup: ${relativePath}`);
            continue;
          }

          if (!s3FilePaths.has(relativePath)) {
            try {
              fs.unlinkSync(fullPath);
              deletedCount++;
              this.logger.info(`Deleted local-only file: ${relativePath}`);
              this.fileSnapshot.delete(relativePath);
            } catch (error) {
              this.logger.error(`Failed to delete ${relativePath}: ${error}`);
            }
          }
        }
      }
    };

    scanDirectory(this.workspaceDir);
    return deletedCount;
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
