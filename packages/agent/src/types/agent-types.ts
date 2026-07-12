/**
 * Agent creation type definitions
 *
 * Pure type definitions for agent creation and metadata.
 * Located in types/ (L0) so that all layers can reference these types.
 */

import type { Agent, Plugin } from '@strands-agents/sdk';
import type { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal';
import type { IdentityId, ReasoningDepth } from '@moca/core';
import type { SessionStorage, SessionConfig } from './session-types.js';
// Type-only import: no runtime dependency on the runtime/ layer, so this does
// not introduce a layering violation or import cycle.
import type { StreamTerminationRetryStrategy } from '../runtime/agent/stream-termination-retry-strategy.js';

/**
 * Strands Agent creation options for AgentCore Runtime.
 *
 * `plugins` (formerly `hooks` in `@strands-agents/sdk@<0.7.0`) are passed
 * to `new Agent({ plugins })`. Each plugin's `initAgent()` is invoked by the
 * SDK to register hook callbacks against the agent's lifecycle events.
 */
export interface CreateAgentOptions {
  plugins?: Plugin[];
  modelId?: string;
  /** Extended-thinking depth resolved against the model registry in createBedrockModel. */
  reasoningEffort?: ReasoningDepth;
  enabledTools?: string[];
  systemPrompt?: string;
  sessionStorage?: SessionStorage;
  sessionConfig?: SessionConfig;
  memoryEnabled?: boolean;
  memoryContext?: string;
  /**
   * Cognito Identity Pool identityId used as the AgentCore Memory actor.
   * Must be the identityId (REGION:UUID), not the User Pool sub.
   */
  actorId?: IdentityId;
  memoryTopK?: number;
  mcpConfig?: Record<string, unknown>;
  /**
   * Absolute paths to pre-synced skills directories (each a `.../.agents/skills/`).
   * Passed to the Strands `AgentSkills` plugin as skill sources; later entries
   * win on name collision. Typically `[sharedSkills, workspaceSkills]` so a
   * workspace-specific skill overrides a same-named shared one. The caller syncs
   * the directories (e.g. `WorkspaceSync.waitForSkillsSync()` /
   * `waitForSharedSkillsSync()`) before calling createAgent — the plugin scans
   * them synchronously.
   */
  skillsPaths?: string[];
  /**
   * Logical agent identifier (from the request body's `agentId`). Forwarded
   * to the Strands SDK as the Agent `id`, which surfaces as
   * `gen_ai.agent.id` on the SDK's `invoke_agent` span and is therefore
   * picked up by AgentCore Observability for trace-level correlation.
   */
  agentId?: string;
  /**
   * Natural-language goal for this turn. When non-empty (after trim), a
   * GoalLoop plugin is attached that iteratively refines the response until a
   * judge Agent decides the goal is met (or bounds are hit). Per-message only —
   * not persisted per-agent or across sessions.
   */
  goal?: string;
  /**
   * Model ID for the GoalLoop judge Agent. Falls back to `GOAL_JUDGE_MODEL_ID`
   * when unset or not found in the model registry.
   */
  goalJudgeModelId?: string;
  /**
   * GoalLoop attempt cap for this turn. Clamped to
   * [GOAL_LOOP_ATTEMPTS_MIN, GOAL_LOOP_ATTEMPTS_MAX]; falls back to
   * GOAL_LOOP_MAX_ATTEMPTS when unset or not a valid integer.
   */
  goalMaxAttempts?: number;
}

/**
 * Agent creation result
 */
export interface CreateAgentResult {
  agent: Agent;
  metadata: AgentMetadata;
  /**
   * The retry strategy instance wired into this agent. Exposed so the stream
   * handler can read `retryStrategy.retryCount` after a turn completes and
   * emit `stream_retry_recovered` when a transient mid-stream truncation was
   * successfully retried. A fresh instance is created per agent, so the count
   * is scoped to this turn.
   */
  retryStrategy: StreamTerminationRetryStrategy;
  /**
   * The GoalLoop plugin attached to this agent, or undefined when no goal was
   * supplied. Exposed so the stream handler can read `goalLoop.lastResult(agent)`
   * after the turn and surface `{ passed, stopReason, attempts }` in the
   * completion event's metadata.
   */
  goalLoop?: GoalLoop;
}

/**
 * Metadata returned after agent creation
 */
export interface AgentMetadata {
  loadedMessagesCount: number;
  longTermMemoriesCount: number;
  toolsCount: number;
  memoryConditions?: MemoryConditions;
}

/**
 * Conditions checked during long-term memory retrieval
 */
export interface MemoryConditions {
  memoryEnabled: boolean;
  hasActorId: boolean;
  hasMemoryContext: boolean;
  hasMemoryId: boolean;
}

/**
 * Parameters for long-term memory retrieval
 */
export interface LongTermMemoryParams {
  enabled: boolean;
  /** Cognito Identity Pool identityId (REGION:UUID) used as AgentCore Memory actorId. */
  actorId?: IdentityId;
  context?: string;
  topK?: number;
}

/**
 * Result of long-term memory retrieval
 */
export interface LongTermMemoryResult {
  memories: string[];
  conditions: MemoryConditions;
}
