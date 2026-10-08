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

// Warmup-started syncs awaiting the next invocation. A microVM serves a single
// runtime session, so this holds at most a handful of entries — no TTL needed:
// the claiming invocation re-pulls (diff-only) to pick up anything changed in S3
// since the warmup, e.g. a file attached after the first keystroke.
const prefetchedSyncs = new Map<string, WorkspaceSync>();

function prefetchKey(userId: UserId, storagePath: string): string {
  return `${userId}\0${storagePath.replace(/^\/+|\/+$/g, '')}`;
}

function startSync(userId: UserId, storagePath: string): WorkspaceSync {
  const workspaceSync = new WorkspaceSync(userId, storagePath);
  workspaceSync.startInitialSync();
  return workspaceSync;
}

/**
 * Start pulling the workspace (and shared skills) ahead of the first invocation.
 * Called from the warmup request so the S3 pull overlaps with the user typing.
 * At most one pending prefetch per (user, storagePath).
 *
 * @returns Settles when the prefetch pull finishes (never rejects), or
 *          undefined when a prefetch for this key is already pending.
 */
export function prefetchWorkspaceSync(
  userId: UserId,
  storagePath: string
): Promise<void> | undefined {
  validateStoragePath(storagePath);

  const key = prefetchKey(userId, storagePath);
  if (prefetchedSyncs.has(key)) {
    return undefined;
  }

  const workspaceSync = startSync(userId, storagePath);
  prefetchedSyncs.set(key, workspaceSync);
  logger.info({ userId, storagePath }, 'Workspace sync prefetch started');

  void workspaceSync.waitForSharedSkillsSync().catch((error: unknown) => {
    logger.warn({ error, storagePath }, 'Shared skills prefetch failed');
  });

  return workspaceSync.waitForInitialSync().catch((error: unknown) => {
    // Don't hand a sync whose credential setup failed to the invocation;
    // a fresh one retries from scratch.
    if (prefetchedSyncs.get(key) === workspaceSync) {
      prefetchedSyncs.delete(key);
    }
    logger.warn({ error, storagePath }, 'Workspace sync prefetch failed');
  });
}

/**
 * Claim (one-shot) a warmup-started sync for this (user, storagePath) and queue
 * a catch-up pull behind it so the invocation sees the current S3 state.
 */
function takePrefetchedWorkspaceSync(
  userId: UserId,
  storagePath: string
): WorkspaceSync | undefined {
  const key = prefetchKey(userId, storagePath);
  const workspaceSync = prefetchedSyncs.get(key);
  if (!workspaceSync) {
    return undefined;
  }
  prefetchedSyncs.delete(key);
  workspaceSync.startInitialSync();
  logger.info({ userId, storagePath }, 'Reusing prefetched workspace sync');
  return workspaceSync;
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

  // Reuse a sync already started by a warmup request; a fresh instance would
  // re-download the whole workspace (only repeat pulls on one instance are diff-based).
  const workspaceSync =
    takePrefetchedWorkspaceSync(userId, storagePath) ?? startSync(userId, storagePath);

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
