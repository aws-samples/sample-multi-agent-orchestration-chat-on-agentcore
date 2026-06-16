/**
 * `AgentsRepository` — the behaviour contract for agent persistence.
 *
 * THIS FILE IS THE WHOLE PUBLIC SURFACE. To *persist* agents you only need this
 * interface plus the domain types in `../../types/agent-types.ts`; you never
 * need to open the `./dynamodb/` implementation. The AgentsService depends on
 * this interface, not on a concrete class.
 *
 * Scope boundary: this layer is pure DynamoDB persistence. It speaks domain
 * {@link Agent} values and a storage-ready {@link UpdateAgentPatch}. It does NOT
 * know about Secrets/SSM env extraction, scenario-id generation, or the
 * frontend cursor encoding — those are AgentsService concerns. Keeping the
 * repository env-free (client + table name injected) is what makes it
 * integration-testable against DynamoDB Local.
 *
 * Contract notes that hold for ANY implementation:
 * - Methods speak only domain {@link Agent} values — never storage rows.
 * - An agent is addressed by `(userId, agentId)`.
 * - Reads of a missing agent return `null` (get), never throw.
 */

import type { UserId, AgentId } from '@moca/core';
import type { Agent, MCPConfig, Scenario } from '../../types/agent-types.js';

// --- Method input/output types ----------------------------------------------
// How you OPERATE on stored agents, as opposed to the domain MODEL in
// `types/agent-types.ts`.

/**
 * A storage-ready partial update. Unlike the route/service-facing
 * `UpdateAgentInput`, every field here is already in its persisted form: the
 * service has resolved SSM env into `mcpConfig` and stamped ids onto
 * `scenarios` before calling. `defaultStoragePath: ''` means "clear it".
 */
export interface UpdateAgentPatch {
  name?: string;
  description?: string;
  icon?: string;
  systemPrompt?: string;
  enabledTools?: string[];
  scenarios?: Scenario[];
  mcpConfig?: MCPConfig;
  defaultStoragePath?: string;
}

/** Page of shared agents from the `isShared-createdAt-index` GSI. */
export interface SharedAgentsPage {
  agents: Agent[];
  /** Marshalled DynamoDB key to resume after, or undefined when exhausted. */
  lastEvaluatedKey?: Record<string, unknown>;
}

export interface AgentsRepository {
  /** List every agent owned by a user (handles internal Query pagination). */
  listByUser(userId: UserId): Promise<Agent[]>;

  /** Get an agent by id, or `null` if the user has no such agent. */
  get(userId: UserId, agentId: AgentId): Promise<Agent | null>;

  /** Persist a brand-new agent row. The caller supplies the fully-built {@link Agent}. */
  put(agent: Agent): Promise<void>;

  /**
   * Apply a storage-ready partial update and return the resulting agent.
   * Always refreshes `updatedAt`.
   * @throws AgentNotFoundError when the agent does not exist.
   */
  update(userId: UserId, agentId: AgentId, patch: UpdateAgentPatch): Promise<Agent>;

  /** Toggle the `isShared` flag and return the resulting agent.
   * @throws AgentNotFoundError when the agent does not exist. */
  toggleShare(userId: UserId, agentId: AgentId): Promise<Agent>;

  /** Delete an agent. Deleting a missing agent is a no-op (idempotent). */
  delete(userId: UserId, agentId: AgentId): Promise<void>;

  /**
   * One GSI page of shared agents, newest first, starting after
   * `exclusiveStartKey`. Name filtering / cursor encoding are the service's job.
   */
  listShared(
    limit: number,
    exclusiveStartKey?: Record<string, unknown>
  ): Promise<SharedAgentsPage>;
}
