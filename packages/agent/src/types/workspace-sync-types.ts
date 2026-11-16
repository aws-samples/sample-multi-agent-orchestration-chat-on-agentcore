/**
 * WorkspaceSync interface definition
 *
 * Located in types/ (L0) so that all layers can reference this type.
 *
 * The concrete WorkspaceSync class in services/ structurally implements
 * this interface.
 */

import type { SyncConflict, SyncResult } from '@moca/s3-workspace-sync';

export type { SyncConflict, SyncResult };

export interface IWorkspaceSync {
  startInitialSync(): void;
  waitForInitialSync(): Promise<void>;
  syncToS3(): Promise<SyncResult>;
  /** Conflicts found by pushes since the last call (awaits pushes in flight). */
  takeConflicts(): Promise<SyncConflict[]>;
  getWorkspacePath(): string;
  getActiveWorkingDirectory(): string;
  /**
   * Wait until the workspace `.agents/skills/` subtree has synced and return its local
   * path, or null when no skills exist. See WorkspaceSync.waitForSkillsSync.
   */
  waitForSkillsSync(): Promise<string | null>;
  /**
   * Pull the user's root (shared) `.agents/skills/` and return its local path, or null
   * when there are none (or the storage path is the root). See
   * WorkspaceSync.waitForSharedSkillsSync.
   */
  waitForSharedSkillsSync(): Promise<string | null>;
}
