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
 * Max lifetime of a cached WorkspaceSync. Its S3 client holds static Identity
 * Pool credentials (~1h), so it is rebuilt well before they expire — leaving
 * headroom for a long invocation that started near the limit.
 */
const SYNC_MAX_AGE_MS = 30 * 60 * 1000;

// One WorkspaceSync per (user, storagePath) for the microVM's lifetime, so each
// invocation (and the warmup) only re-pulls what changed in S3 — a fresh
// instance re-downloads the whole workspace and shared skills. A microVM serves
// a single runtime session, so this holds a handful of entries at most.
const workspaceSyncs = new Map<string, { workspaceSync: WorkspaceSync; createdAt: number }>();

function syncKey(userId: UserId, storagePath: string): string {
  return `${userId}\0${storagePath.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * Return the cached sync for (user, storagePath) — or a new one — and start a
 * background (diff-only when cached) pull on it.
 */
function acquireWorkspaceSync(userId: UserId, storagePath: string): WorkspaceSync {
  const key = syncKey(userId, storagePath);
  const now = Date.now();
  const cached = workspaceSyncs.get(key);
  if (cached && now - cached.createdAt < SYNC_MAX_AGE_MS) {
    cached.workspaceSync.startInitialSync();
    return cached.workspaceSync;
  }

  const workspaceSync = new WorkspaceSync(userId, storagePath);
  workspaceSync.startInitialSync();
  const entry = { workspaceSync, createdAt: now };
  workspaceSyncs.set(key, entry);
  // Don't keep an instance whose credential setup failed; the next call retries.
  workspaceSync.waitForInitialSync().catch(() => {
    if (workspaceSyncs.get(key) === entry) {
      workspaceSyncs.delete(key);
    }
  });
  return workspaceSync;
}

/**
 * Start pulling the workspace (and shared skills) ahead of the next invocation.
 * Called from the warmup request so the S3 pull overlaps with the user typing;
 * the invocation then reuses the same cached sync.
 *
 * @returns Settles (never rejects) when both pulls have finished.
 */
export function prefetchWorkspaceSync(userId: UserId, storagePath: string): Promise<void> {
  validateStoragePath(storagePath);

  const workspaceSync = acquireWorkspaceSync(userId, storagePath);
  logger.info({ userId, storagePath }, 'Workspace sync prefetch started');

  return Promise.allSettled([
    workspaceSync.waitForInitialSync(),
    workspaceSync.waitForSharedSkillsSync(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn({ error: result.reason, storagePath }, 'Workspace sync prefetch failed');
      }
    }
  });
}

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

  const workspaceSync = acquireWorkspaceSync(userId, storagePath);

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
export async function resolveSkillsPaths(workspaceSync?: WorkspaceSync | null): Promise<string[]> {
  if (!workspaceSync) return [BUNDLED_SKILLS_DIRECTORY];

  const synced = await Promise.all([
    workspaceSync.waitForSharedSkillsSync(),
    workspaceSync.waitForSkillsSync(),
  ]);

  return [BUNDLED_SKILLS_DIRECTORY, ...synced.filter((p): p is string => p !== null)];
}
