/**
 * Agent creation type definitions
 *
 * Pure type definitions for agent creation and metadata.
 * Located in types/ (L0) so that all layers can reference these types.
 */

import type { Agent, Plugin } from '@strands-agents/sdk';
import type { IdentityId } from '@moca/core';
import type { SessionStorage, SessionConfig } from './session-types.js';

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
   * Logical agent identifier (from the request body's `agentId`). Forwarded
   * to the Strands SDK as the Agent `id`, which surfaces as
   * `gen_ai.agent.id` on the SDK's `invoke_agent` span and is therefore
   * picked up by AgentCore Observability for trace-level correlation.
   */
  agentId?: string;
}

/**
 * Agent creation result
 */
export interface CreateAgentResult {
  agent: Agent;
  metadata: AgentMetadata;
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
