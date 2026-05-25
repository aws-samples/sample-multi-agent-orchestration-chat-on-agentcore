/**
 * Workspace Sync Hook
 * Automatically synchronizes the local workspace with S3 after tool execution
 */

import { AfterToolsEvent } from '@strands-agents/sdk';
import type { Plugin } from '@strands-agents/sdk';
import type { LocalAgent } from '@strands-agents/sdk';
import type { IWorkspaceSync } from '../../types/workspace-sync-types.js';
import { logger } from '../../libs/logger/index.js';
/**
 * Plugin that synchronizes the workspace with S3 after tool execution.
 *
 * Migrated from `HookProvider` to `Plugin` for `@strands-agents/sdk@>=0.7.0`,
 * which removed the `HookProvider`/`HookRegistry` API in favor of a Plugin
 * interface that registers hooks via `agent.addHook()` inside `initAgent()`.
 */
export class WorkspaceSyncHook implements Plugin {
  readonly name = 'moca:workspace-sync-hook';

  constructor(private readonly workspaceSync: IWorkspaceSync) {}

  /**
   * Register hook callbacks on the agent.
   * Called by the Agent's PluginRegistry during construction.
   */
  initAgent(agent: LocalAgent): void {
    // Sync to S3 after tool execution
    agent.addHook(AfterToolsEvent, (event) => this.onAfterTools(event));
  }

  /**
   * Event handler after tool execution
   * Syncs after every tool execution since file operations may have occurred
   */
  private async onAfterTools(_event: AfterToolsEvent): Promise<void> {
    try {
      logger.info('[WORKSPACE_SYNC_HOOK] Triggering sync to S3 after tool execution...');

      // Run sync asynchronously (does not block the response)
      // Agent execution continues even if an error occurs
      this.workspaceSync.syncToS3().catch((error) => {
        logger.error({ err: error }, '[WORKSPACE_SYNC_HOOK] Sync to S3 failed:');
      });
    } catch (error) {
      // Do not stop Agent execution even if an error occurs in the hook
      logger.warn({ err: error }, '[WORKSPACE_SYNC_HOOK] Error in hook:');
    }
  }
}
