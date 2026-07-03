/**
 * WorkspaceSync interface definition
 *
 * Located in types/ (L0) so that all layers can reference this type.
 *
 * The concrete WorkspaceSync class in services/ structurally implements
 * this interface.
 */

import type { SyncResult, SyncProgress } from '@moca/s3-workspace-sync';

export type { SyncResult };

/**
 * Snapshot of the initial-pull lifecycle, surfaced to subscribers (e.g. the
 * stream handler) so they can report sync progress to the UI.
 */
export type WorkspaceSyncStatus =
  | { phase: 'idle' }
  | { phase: 'syncing'; progress: SyncProgress }
  | { phase: 'complete' }
  | { phase: 'error'; message: string };

export type WorkspaceSyncStatusListener = (status: WorkspaceSyncStatus) => void;

export interface IWorkspaceSync {
  startInitialSync(): void;
  waitForInitialSync(): Promise<void>;
  syncToS3(): Promise<SyncResult>;
  getWorkspacePath(): string;
  getActiveWorkingDirectory(): string;
  /** Subscribe to initial-pull status; replays current status synchronously.
   * Returns an unsubscribe function. */
  onStatusChange(listener: WorkspaceSyncStatusListener): () => void;
  /** The last observed status of the initial pull. */
  getStatus(): WorkspaceSyncStatus;
}
