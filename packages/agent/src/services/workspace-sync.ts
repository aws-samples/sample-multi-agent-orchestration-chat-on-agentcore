/**
 * Workspace Sync Service
 * Thin adapter over @moca/s3-workspace-sync that maps
 * the agent-specific (userId, storagePath) convention to the generic package API.
 *
 * The local workspace directory includes the storagePath as a subdirectory
 * (e.g., storagePath="/dev2" → workspaceDir="/tmp/ws/dev2") so that local
 * filesystem paths align with S3 display paths after stripping WORKSPACE_DIRECTORY.
 */

import path from 'path';
import { S3WorkspaceSync } from '@moca/s3-workspace-sync';
import type { SyncResult } from '@moca/s3-workspace-sync';
import { config, WORKSPACE_DIRECTORY } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';
import { createUserScopedS3Client, getIdentityId } from '../libs/utils/scoped-credentials.js';
import { normalizePath, buildUserPrefix } from '../libs/utils/storage-path.js';

const logger = createLogger('WorkspaceSync');
export type { SyncResult };

/**
 * Agent-specific workspace sync wrapper.
 *
 * Maps `(userId, storagePath)` to an S3 prefix of the form
 * `users/{userId}/{storagePath}/` and syncs files into
 * `WORKSPACE_DIRECTORY/{storagePath}/` so that stripping WORKSPACE_DIRECTORY
 * from any local path yields a valid S3 display path.
 */
export class WorkspaceSync {
  // inner is set inside initPromise and guaranteed to be non-null before any
  // public method is called (all public methods await initPromise first).
  private inner!: S3WorkspaceSync;
  private readonly activeWorkingDirectory: string;
  private readonly bucketName: string;
  private readonly normalizedStoragePath: string;

  private initPromise: Promise<void>;

  constructor(userId: string, storagePath: string) {
    this.bucketName = config.USER_STORAGE_BUCKET_NAME ?? '';
    this.normalizedStoragePath = normalizePath(storagePath);

    const workspaceDir = this.normalizedStoragePath
      ? path.join(WORKSPACE_DIRECTORY, this.normalizedStoragePath)
      : WORKSPACE_DIRECTORY;

    this.activeWorkingDirectory = workspaceDir;

    // Build the S3WorkspaceSync only after the S3 client and identityId have been
    // resolved so that the scoped client and correct prefix are ready before any
    // sync operation begins.
    this.initPromise = this.initSync(userId);
  }

  /**
   * Resolve the Identity Pool credentials (which also resolves the identityId)
   * and create the inner S3WorkspaceSync with the correct per-user prefix.
   *
   * S3 prefix is keyed on identityId (Identity Pool sub, format "REGION:uuid")
   * because ${cognito-identity.amazonaws.com:sub} is the IAM policy variable that
   * is correctly expanded when credentials come from GetCredentialsForIdentity.
   */
  private async initSync(userId: string): Promise<void> {
    let s3Client: import('@aws-sdk/client-s3').S3Client | undefined;
    let storageKey = userId; // fallback for local dev without Identity Pool

    if (config.IDENTITY_POOL_ID) {
      // Resolve identityId first — this is the key used for all storage.
      // createUserScopedS3Client internally calls assumeUserScopedRole which
      // stores identityId in the request context.
      const resolvedIdentityId = await getIdentityId(userId);
      storageKey = resolvedIdentityId;
      s3Client = await createUserScopedS3Client(userId);
      logger.debug(
        `Using Identity Pool scoped S3 client for user=${userId}, ` +
          `identityId=${resolvedIdentityId}`
      );
    } else {
      logger.warn(
        `IDENTITY_POOL_ID is not set. ` +
          `Using execution role for user=${userId} — ` +
          `ensure IAM policy restricts access to the users/${userId}/ prefix.`
      );
    }

    // Build S3 prefix using identityId (or userId fallback for local dev).
    // buildUserPrefix keeps the `users/{key}/{path}/` convention in one place
    // so this never drifts from s3_list_files / browser screenshot paths.
    const prefix = buildUserPrefix(storageKey, this.normalizedStoragePath);

    this.inner = new S3WorkspaceSync({
      bucket: this.bucketName,
      prefix,
      workspaceDir: this.activeWorkingDirectory,
      region: config.AWS_REGION,
      s3Client,
      logger: logger,
    });
  }

  /**
   * Start initial sync in the background (non-blocking).
   * Waits for scoped client initialization first.
   */
  startInitialSync(): void {
    this.initPromise.then(() => {
      this.inner.startBackgroundPull();
    });
  }

  /**
   * Wait for the initial sync to complete.
   */
  async waitForInitialSync(): Promise<void> {
    await this.initPromise;
    await this.inner.waitForPull();
  }

  /**
   * Upload local changes to S3 (diff-based).
   */
  async syncToS3(): Promise<SyncResult> {
    await this.initPromise;
    return this.inner.push();
  }

  /**
   * Get the workspace directory path.
   */
  getWorkspacePath(): string {
    return this.inner.getWorkspacePath();
  }

  /**
   * Get the active working directory path (where files are synced).
   * e.g., "/tmp/ws/dev2" when storagePath is "/dev2", "/tmp/ws" when storagePath is "/".
   */
  getActiveWorkingDirectory(): string {
    return this.activeWorkingDirectory;
  }
}
