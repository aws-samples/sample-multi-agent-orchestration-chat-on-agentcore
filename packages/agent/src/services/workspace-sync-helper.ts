/**
 * Workspace sync initialization helper
 */

import type { UserId } from '@moca/core';
import { WorkspaceSync } from './workspace-sync.js';
import { validateStoragePath } from '@moca/s3-workspace-sync';
import { WorkspaceSyncHook } from './session/workspace-sync-hook.js';
import type { RequestContext } from '../libs/context/request-context.js';
import { logger } from '../libs/logger/index.js';
/**
 * Result of workspace sync initialization
 */
export interface WorkspaceSyncResult {
  workspaceSync: WorkspaceSync;
  hook: WorkspaceSyncHook;
}

// Re-export for backward compatibility
export { validateStoragePath };

/**
 * Initialize workspace sync for the given storage path.
 *
 * Callers pass a branded `UserId` resolved upstream by
 * `authResolverMiddleware`, so the helper no longer needs to defend
 * against an `'anonymous'` sentinel — unauthenticated requests are
 * rejected before reaching this code path.
 *
 * The caller is responsible for deciding whether a workspace sync is
 * needed (i.e. gating on the presence of `storagePath`). This keeps the
 * side-effect boundary visible at the call site.
 *
 * @param userId Authenticated Cognito User Pool sub
 * @param storagePath S3 storage path (required)
 * @param context Request context to attach workspace sync
 * @returns WorkspaceSync instance and hook
 */
export function initializeWorkspaceSync(
  userId: UserId,
  storagePath: string,
  context?: RequestContext
): WorkspaceSyncResult {
  // Validate storage path for security
  validateStoragePath(storagePath);

  const workspaceSync = new WorkspaceSync(userId, storagePath);

  // Start initial sync asynchronously (don't await)
  workspaceSync.startInitialSync();

  // Set WorkspaceSync in context (accessible from tools)
  if (context) {
    context.workspaceSync = workspaceSync;
  }

  // Create WorkspaceSyncHook
  const hook = new WorkspaceSyncHook(workspaceSync);

  logger.debug({ userId, storagePath }, 'Initialized workspace sync');

  return { workspaceSync, hook };
}
