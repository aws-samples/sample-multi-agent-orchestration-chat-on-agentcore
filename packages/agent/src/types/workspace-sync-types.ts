/**
 * WorkspaceSync interface definition
 *
 * Located in types/ (L0) so that all layers can reference this type.
 *
 * The concrete WorkspaceSync class in services/ structurally implements
 * this interface.
 */

import type { SyncResult } from '@moca/s3-workspace-sync';

export type { SyncResult };

export interface IWorkspaceSync {
  startInitialSync(): void;
  waitForInitialSync(): Promise<void>;
  syncToS3(): Promise<SyncResult>;
  getWorkspacePath(): string;
  getActiveWorkingDirectory(): string;
}
