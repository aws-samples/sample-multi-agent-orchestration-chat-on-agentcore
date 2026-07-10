/**
 * Workspace sync initialization helper
 */

import type { UserId } from '@moca/core';
import { WorkspaceSync } from './workspace-sync.js';
import { validateStoragePath } from '@moca/s3-workspace-sync';
import { WorkspaceSyncHook } from './session/workspace-sync-hook.js';
import type { RequestContext } from '../libs/context/request-context.js';
import { BUNDLED_SKILLS_DIRECTORY } from '../config/index.js';
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

/**
 * Resolve the ordered skill-source paths handed to the Strands `AgentSkills`
 * plugin (via `CreateAgentOptions.skillsPaths`).
 *
 * Sources are returned in override order — `AgentSkills` lets later entries win
 * on a name collision, so more specific sources come last:
 *   1. bundled `skills/` — platform skills baked into the image (e.g.
 *      moca-guide). Always present, no I/O; listed first so a user's shared or
 *      workspace skill of the same name can override it.
 *   2. shared root `.agents/skills/` — a separate read-only S3 pull.
 *   3. workspace `.agents/skills/` — the priority phase of the main full pull
 *      (unblocks as soon as it's on disk; the rest keeps pulling in background).
 *
 * The two synced sources are awaited in parallel and dropped when absent (each
 * returns null so the plugin isn't initialized with an empty directory); the
 * bundled path needs no wait. Pass `null`/`undefined` when no workspace sync is
 * active to get just the bundled path.
 */
export async function resolveSkillsPaths(
  workspaceSync?: WorkspaceSync | null
): Promise<string[]> {
  if (!workspaceSync) return [BUNDLED_SKILLS_DIRECTORY];

  const synced = await Promise.all([
    workspaceSync.waitForSharedSkillsSync(),
    workspaceSync.waitForSkillsSync(),
  ]);

  return [BUNDLED_SKILLS_DIRECTORY, ...synced.filter((p): p is string => p !== null)];
}
