/**
 * Agent creation type definitions
 *
 * Pure type definitions for agent creation and metadata.
 * Located in types/ (L0) so that all layers can reference these types.
 */

import type { Agent, HookProvider } from '@strands-agents/sdk';
import type { IdentityId } from '@moca/core';
import type { SessionStorage, SessionConfig } from './session-types.js';

/**
 * Strands Agent creation options for AgentCore Runtime
 */
export interface CreateAgentOptions {
  hooks?: HookProvider[];
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
