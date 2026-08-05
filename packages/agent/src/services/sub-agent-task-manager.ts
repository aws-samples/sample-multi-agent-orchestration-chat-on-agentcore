/**
 * Sub-Agent Task Manager
 * Manages asynchronous execution of sub-agent tasks
 */

import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import { createAgent } from '../agent.js';
import { getAgentDefinition } from './agent-registry.js';
import { getCurrentContext, runWithContext } from '../libs/context/request-context.js';
import { WorkspaceSync } from './workspace-sync.js';
import { resolveSkillsPaths } from './workspace-sync-helper.js';
import { WorkspaceSyncHook } from './session/workspace-sync-hook.js';
import { AgentCoreMemoryStorage } from './session/agentcore-memory-storage.js';
import { SessionPersistenceHook } from './session/session-persistence-hook.js';
import { createSessionPersistenceDeps } from './session-persistence-deps-factory.js';
import {
  getIdentityId,
  createUserScopedBedrockAgentCoreClient,
} from '../libs/utils/scoped-credentials.js';

import { generateSessionId, parseSessionId } from '@moca/core';
import { RUNTIME_TOOL_NAMES } from '@moca/tool-definitions';
import type { SessionId, UserId } from '@moca/core';
import type { Plugin } from '@strands-agents/sdk';
import type { CreateAgentOptions } from '../types/agent-types.js';

/**
 * Task status
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Sub-agent task definition
 */
export interface SubAgentTask {
  taskId: string;
  agentId: string;
  query: string;
  modelId?: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  progress?: string;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
  sessionId?: string;
  /**
   * Cognito User Pool sub (UUID). Always a branded `UserId` when present —
   * the sub-agent flow re-uses the parent request's verified userId.
   */
  userId?: UserId;
  maxDepth: number;
  currentDepth: number;
  storagePath?: string;
  /** Captured auth header from parent request context (for Backend API calls in background) */
  authHeader?: string;
  /** Captured Cognito ID Token from parent request context (for Identity Pool credential exchange in background) */
  idToken?: string;
  /**
   * Aborts this task's agent turn. Fed to `agent.invoke` as `cancelSignal` so a
   * cancel request stops the sub-agent at the next SDK checkpoint. Not persisted
   * / not serialized — it only lives for the duration of the background run.
   */
  abortController?: AbortController;
}

/**
 * Sub-Agent Task Manager
 * Manages task lifecycle and execution
 */
class SubAgentTaskManager {
  private tasks: Map<string, SubAgentTask> = new Map();
  private readonly MAX_TASKS_PER_SESSION = 5;
  private readonly TASK_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Create a new task and start execution in background
   */
  async createTask(
    agentId: string,
    query: string,
    options: {
      modelId?: string;
      parentSessionId?: string;
      sessionId?: string;
      userId?: UserId;
      currentDepth?: number;
      maxDepth?: number;
      storagePath?: string;
    } = {}
  ): Promise<string> {
    // Check task limit per session
    if (options.parentSessionId) {
      const sessionTasks = Array.from(this.tasks.values()).filter(
        (t) => t.parentSessionId === options.parentSessionId && t.status !== 'completed'
      );
      if (sessionTasks.length >= this.MAX_TASKS_PER_SESSION) {
        throw new Error(
          `Maximum concurrent tasks (${this.MAX_TASKS_PER_SESSION}) reached for this session`
        );
      }
    }

    const taskId = this.generateTaskId();
    // Generate sessionId if not provided (pure alphanumeric, sessionType identifies it as subagent)
    const sessionId = options.sessionId || generateSessionId();

    // Capture auth header and ID token from current request context while still in AsyncLocalStorage scope.
    // Background executeTask() runs outside the original context, so we save them here.
    const parentContext = getCurrentContext();
    const authHeader = parentContext?.authorizationHeader;
    const idToken = parentContext?.idToken;

    const task: SubAgentTask = {
      taskId,
      agentId,
      query,
      modelId: options.modelId,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentSessionId: options.parentSessionId,
      sessionId,
      userId: options.userId,
      maxDepth: options.maxDepth || 2,
      currentDepth: options.currentDepth || 0,
      storagePath: options.storagePath,
      authHeader,
      idToken,
      abortController: new AbortController(),
    };

    this.tasks.set(taskId, task);

    // Start background execution (don't await)
    this.executeTask(taskId).catch((error) => {
      logger.error({ taskId, error }, 'Background task execution error:');
      this.updateTaskStatus(taskId, 'failed', undefined, error.message);
    });

    logger.info(
      {
        taskId,
        agentId,
        modelId: options.modelId,
        depth: `${options.currentDepth}/${options.maxDepth}`,
      },
      'Sub-agent task created:'
    );

    return taskId;
  }

  /**
   * Execute task in background
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error({ taskId }, 'Task not found:');
      return;
    }

    // Reconstruct a minimal RequestContext inside AsyncLocalStorage so that
    // scoped-credentials.ts (called from getIdentityId → assumeUserScopedRole)
    // can find the Cognito ID Token even though executeTask() runs outside the
    // original HTTP request context.
    const restoredContext = {
      requestId: `subtask-${taskId}`,
      startTime: new Date(),
      isMachineUser: false,
      userId: task.userId,
      authorizationHeader: task.authHeader,
      idToken: task.idToken,
      storagePath: task.storagePath ?? '/',
    };

    return runWithContext(restoredContext, () => this._executeTaskInContext(taskId, task));
  }

  /**
   * Inner execution logic, called inside a restored AsyncLocalStorage context
   */
  private async _executeTaskInContext(taskId: string, task: SubAgentTask): Promise<void> {
    try {
      // Update status to running
      this.updateTaskStatus(taskId, 'running', 'Initializing sub-agent...');

      // Get agent definition from backend API
      // Use captured authHeader and userId from createTask to avoid AsyncLocalStorage context loss
      const agentDef = await getAgentDefinition(task.agentId, {
        authHeader: task.authHeader,
        userId: task.userId,
      });
      if (!agentDef) {
        throw new Error(`Agent "${task.agentId}" not found`);
      }

      this.updateTaskStatus(taskId, 'running', 'Creating agent instance...');

      const context = getCurrentContext();

      // Use stored userId or fallback to context
      const userId = task.userId || context?.userId;

      // Initialize workspace sync if storagePath is provided and we have userId
      let workspaceSync: WorkspaceSync | null = null;
      let workspaceSyncHook: WorkspaceSyncHook | null = null;

      if (task.storagePath && userId) {
        workspaceSync = new WorkspaceSync(userId, task.storagePath);
        workspaceSync.startInitialSync();

        if (context) {
          context.workspaceSync = workspaceSync;
        }

        workspaceSyncHook = new WorkspaceSyncHook(workspaceSync);

        logger.info(
          {
            taskId,
            userId,
            storagePath: task.storagePath,
          },
          'Initialized workspace sync for sub-agent:'
        );
      }

      // Initialize session persistence if we have userId and sessionId.
      // `Plugin` replaces the legacy `HookProvider` interface (SDK >=0.7.0).
      const plugins: Plugin[] = workspaceSyncHook ? [workspaceSyncHook] : [];
      let sessionStorage = undefined;
      let sessionConfig = undefined;

      if (userId && task.sessionId && config.AGENTCORE_MEMORY_ID) {
        // Build a user-scoped BedrockAgentCoreClient so that CreateEvent /
        // ListEvents on the sub-agent's Memory session are evaluated under the
        // `bedrock-agentcore:actorId` condition on the Authenticated Role.
        const memoryClient = await createUserScopedBedrockAgentCoreClient(userId);
        sessionStorage = new AgentCoreMemoryStorage(config.AGENTCORE_MEMORY_ID, memoryClient);

        // task.sessionId is either generated via generateSessionId() (already SessionId)
        // or provided externally — validate with parseSessionId
        const validSessionId: SessionId = parseSessionId(task.sessionId);

        // AgentCore Memory and DynamoDB sessions are keyed by identityId
        // (Identity Pool sub, format "REGION:uuid"), not the User Pool sub.
        // userId here is the User Pool sub — resolve it to identityId first.
        const memoryActorId = await getIdentityId(userId);

        sessionConfig = {
          actorId: memoryActorId,
          sessionId: validSessionId,
          sessionType: 'subagent' as const,
        };

        // Add session persistence hook (pass agentId and storagePath for DynamoDB session metadata)
        const sessionPersistenceHook = new SessionPersistenceHook(
          sessionStorage,
          sessionConfig,
          createSessionPersistenceDeps(),
          task.agentId,
          task.storagePath
        );
        plugins.push(sessionPersistenceHook);

        logger.info(
          {
            taskId,
            sessionId: task.sessionId,
            actorId: memoryActorId,
            memoryId: config.AGENTCORE_MEMORY_ID,
          },
          'Initialized session persistence for sub-agent:'
        );
      }

      // Create sub-agent with session persistence
      const agentOptions: CreateAgentOptions = {
        plugins,
        systemPrompt: agentDef.systemPrompt,
        // Filter out call_agent to prevent infinite recursion
        enabledTools: agentDef.enabledTools.filter(
          (t: string) => t !== RUNTIME_TOOL_NAMES.CALL_AGENT
        ),
        modelId: task.modelId || agentDef.modelId,
        sessionStorage,
        sessionConfig,
        // Wait for synced skill sources before construction (the plugin scans
        // them synchronously); see resolveSkillsPaths for order and rationale.
        skillsPaths: await resolveSkillsPaths(workspaceSync),
      };
      const { agent } = await createAgent(agentOptions);

      // Set depth and storagePath in agent state.
      // Note: `agent.state` was renamed to `agent.appState` in
      // `@strands-agents/sdk@>=0.7.0` (PR #685).
      agent.appState.set('subAgentDepth', task.currentDepth + 1);
      if (task.storagePath) {
        agent.appState.set('storagePath', task.storagePath);
      }

      this.updateTaskStatus(taskId, 'running', 'Executing query...');

      // Execute query. The cancelSignal lets cancelTask / cancelTasksByParentSession
      // interrupt the turn at the SDK's next checkpoint; the SDK returns an
      // AgentResult with stopReason 'cancelled' rather than throwing.
      const result = await agent.invoke(task.query, {
        cancelSignal: task.abortController?.signal,
      });

      // A cancelled turn is not a completion — reflect it distinctly so callers
      // (and the status tool) can tell "user stopped it" from "it finished".
      if (task.abortController?.signal.aborted || result?.stopReason === 'cancelled') {
        this.updateTaskStatus(taskId, 'cancelled', undefined, 'Cancelled');
        logger.info({ taskId, agentId: task.agentId }, 'Sub-agent task cancelled:');
        return;
      }

      // Update to completed
      this.updateTaskStatus(taskId, 'completed', String(result));

      logger.info(
        {
          taskId,
          agentId: task.agentId,
          duration: Date.now() - task.createdAt,
        },
        'Sub-agent task completed:'
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.updateTaskStatus(taskId, 'failed', undefined, errorMessage);
      logger.error({ taskId, error }, 'Sub-agent task failed:');
    }
  }

  /**
   * Update task status
   */
  private updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: string,
    error?: string
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = status;
    task.updatedAt = Date.now();

    if (result !== undefined) {
      task.result = result;
      task.progress = undefined;
    }

    if (error !== undefined) {
      task.error = error;
    }

    // For running status, treat result as progress message
    if (status === 'running' && result !== undefined) {
      task.progress = result;
      task.result = undefined;
    }

    this.tasks.set(taskId, task);
  }

  /**
   * Cancel a single running task by aborting its agent turn.
   *
   * Cooperative: the SDK stops at its next checkpoint and _executeTaskInContext
   * transitions the task to 'cancelled'. No-op for unknown or already-settled
   * tasks. Returns true if a cancel was actually signalled.
   */
  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }
    task.abortController?.abort();
    return true;
  }

  /**
   * Cancel every not-yet-settled task spawned by a given parent session.
   *
   * This is the propagation path from a cancelled main turn: when the user stops
   * the primary agent, its in-flight sub-agent tasks must stop too rather than
   * keep billing the microVM. Returns the number of tasks signalled.
   */
  cancelTasksByParentSession(parentSessionId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === parentSessionId && this.cancelTask(task.taskId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Cancel all not-yet-settled tasks. Used on shutdown paths and by tests.
   */
  cancelAllTasks(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (this.cancelTask(task.taskId)) count++;
    }
    return count;
  }

  /**
   * Get task by ID
   */
  async getTask(taskId: string): Promise<SubAgentTask | null> {
    return this.tasks.get(taskId) || null;
  }

  /**
   * Clean up old completed/failed tasks
   */
  async cleanupOldTasks(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      const age = now - task.createdAt;
      if (age > this.TASK_EXPIRATION_MS && ['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.tasks.delete(taskId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info({ count: cleanedCount }, 'Cleaned up old tasks:');
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      running: tasks.filter((t) => t.status === 'running').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
    };
  }
}

// Singleton instance
export const subAgentTaskManager = new SubAgentTaskManager();

// Periodic cleanup (every hour)
setInterval(
  () => {
    subAgentTaskManager.cleanupOldTasks();
  },
  60 * 60 * 1000
);
