/**
 * Agent Management Service
 * Manages user Agents using DynamoDB
 */

import { v7 as uuidv7 } from 'uuid';
import type { UserId, AgentId } from '@moca/core';
import { config } from '../config/index.js';
import { SsmEnvStore } from './ssm-env-store.js';
import {
  extractEnvFromMcpConfig,
  restoreEnvToMcpConfig,
  stripEnvFromMcpConfig,
  hasSsmSentinel,
} from './mcp-env-helpers.js';
import type {
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  PaginatedResult,
} from '../types/index.js';
import { AgentNotFoundError } from '../types/index.js';
import type { AgentsRepository, UpdateAgentPatch } from '../repositories/agents/index.js';
import { getAgentsRepository } from './agents-repository.factory.js';
import { logger } from '../libs/logger/index.js';

// Re-export types for backward compatibility
export type {
  MCPServer,
  MCPConfig,
  Scenario,
  Agent,
  CreateAgentInput,
  UpdateAgentInput,
  PaginatedResult,
} from '../types/index.js';

/**
 * Agent management service.
 *
 * Owns the agent application policy — SSM env extraction/restoration, scenario
 * id stamping, the shared-agent name filter + opaque cursor, and the
 * share/clone rules. All DynamoDB persistence is delegated to an injected
 * {@link AgentsRepository}; the service holds no table, key, or marshalling
 * knowledge. Construct via {@link createAgentsService}.
 */
export class AgentsService {
  private readonly repo: AgentsRepository;
  private readonly ssmEnvStore: SsmEnvStore;

  constructor(repo: AgentsRepository, ssmEnvStore: SsmEnvStore) {
    this.repo = repo;
    this.ssmEnvStore = ssmEnvStore;
  }

  /**
   * Get list of Agents for a user.
   */
  async listAgents(userId: UserId): Promise<Agent[]> {
    return this.repo.listByUser(userId);
  }

  /**
   * Get a specific Agent (with env values resolved from SSM if available).
   */
  async getAgent(userId: UserId, agentId: AgentId): Promise<Agent | null> {
    const agent = await this.repo.get(userId, agentId);
    if (!agent) {
      return null;
    }

    // Resolve env values from SSM if sentinel is present
    if (agent.mcpConfig && hasSsmSentinel(agent.mcpConfig)) {
      const envMap = await this.ssmEnvStore.get(userId, agentId);
      if (envMap) {
        agent.mcpConfig = restoreEnvToMcpConfig(agent.mcpConfig, envMap);
      }
    }

    return agent;
  }

  /**
   * Create a new Agent.
   */
  async createAgent(userId: UserId, input: CreateAgentInput, username?: string): Promise<Agent> {
    const now = new Date().toISOString();
    const agentId = uuidv7() as AgentId;

    // Extract env values and store in SSM; the DB row keeps a sentinel instead.
    let mcpConfigForDb = input.mcpConfig;
    const originalMcpConfig = input.mcpConfig;

    if (input.mcpConfig) {
      const { sanitizedConfig, envMap } = extractEnvFromMcpConfig(input.mcpConfig);
      if (envMap) {
        await this.ssmEnvStore.save(userId, agentId, envMap);
        mcpConfigForDb = sanitizedConfig;
      }
    }

    const agent: Agent = {
      userId,
      agentId,
      name: input.name,
      description: input.description,
      icon: input.icon,
      systemPrompt: input.systemPrompt,
      enabledTools: input.enabledTools,
      scenarios: input.scenarios.map((scenario) => ({ ...scenario, id: uuidv7() })),
      mcpConfig: mcpConfigForDb,
      defaultStoragePath: input.defaultStoragePath,
      createdAt: now,
      updatedAt: now,
      isShared: false, // Default to private
      createdBy: username || userId, // Use userId if username is not available
    };

    await this.repo.put(agent);

    // Return agent with the original (unmasked) env values
    return { ...agent, mcpConfig: originalMcpConfig };
  }

  /**
   * Update an Agent
   */
  async updateAgent(userId: UserId, input: UpdateAgentInput): Promise<Agent> {
    const { agentId, scenarios, mcpConfig, ...rest } = input;

    // Translate the route-facing input into a storage-ready patch: stamp ids
    // onto scenarios and split mcpConfig env (pure — no SSM I/O yet). The
    // dynamic UpdateExpression and the not-found guard are the repository's job.
    const patch: UpdateAgentPatch = { ...rest };

    if (scenarios !== undefined) {
      patch.scenarios = scenarios.map((scenario) => ({ ...scenario, id: uuidv7() }));
    }

    // Pre-compute the SSM mutation but DO NOT apply it yet: the row update must
    // run first so a missing/other-user agent rejects (AgentNotFoundError)
    // before we touch SSM — otherwise a no-op update could orphan, or wrongly
    // delete, an SSM parameter.
    let commitEnv: (() => Promise<void>) | undefined;
    if (mcpConfig !== undefined) {
      const { sanitizedConfig, envMap } = extractEnvFromMcpConfig(mcpConfig);
      if (envMap) {
        patch.mcpConfig = sanitizedConfig;
        commitEnv = () => this.ssmEnvStore.save(userId, agentId, envMap);
      } else {
        patch.mcpConfig = mcpConfig;
        // No env values — clear any stale SSM parameter (best-effort).
        commitEnv = () => this.ssmEnvStore.delete(userId, agentId).catch(() => {});
      }
    }

    const updated = await this.repo.update(userId, agentId, patch);
    await commitEnv?.();
    return updated;
  }

  /**
   * Delete an Agent.
   */
  async deleteAgent(userId: UserId, agentId: AgentId): Promise<void> {
    // Delete SSM parameter (best-effort) before the row.
    await this.ssmEnvStore.delete(userId, agentId).catch((err) => {
      logger.warn({ err: err }, 'Failed to delete SSM parameter for agent, continuing:');
    });

    await this.repo.delete(userId, agentId);
  }

  /**
   * Initialize default Agents
   * Called when a user logs in for the first time
   */
  async initializeDefaultAgents(
    userId: UserId,
    defaultAgents: CreateAgentInput[],
    username?: string
  ): Promise<Agent[]> {
    try {
      const createdAgents: Agent[] = [];

      for (const agentInput of defaultAgents) {
        const agent = await this.createAgent(userId, agentInput, username);
        createdAgents.push(agent);
      }

      return createdAgents;
    } catch (error) {
      logger.error({ err: error }, 'Error initializing default agents:');
      throw new Error('Failed to initialize default agents', { cause: error });
    }
  }

  /**
   * Toggle the sharing state of an Agent.
   */
  async toggleShare(userId: UserId, agentId: AgentId): Promise<Agent> {
    return this.repo.toggleShare(userId, agentId);
  }

  /**
   * Get list of shared Agents (with pagination + optional name filter).
   *
   * The repository returns one raw GSI page; this method owns the opaque cursor
   * (base64 of the marshalled LastEvaluatedKey) and the case-insensitive name
   * filter — both application concerns, not storage concerns.
   */
  async listSharedAgents(
    limit: number = 20,
    searchQuery?: string,
    cursor?: string
  ): Promise<PaginatedResult<Agent>> {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    if (cursor) {
      try {
        exclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
      } catch (error) {
        logger.error({ err: error }, 'Invalid cursor format:');
        throw new Error('Invalid pagination cursor', { cause: error });
      }
    }

    const { agents, lastEvaluatedKey } = await this.repo.listShared(limit, exclusiveStartKey);

    // Filter by name if a search query is provided.
    let items = agents;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      items = items.filter((agent) => agent.name.toLowerCase().includes(query));
    }

    const nextCursor = lastEvaluatedKey
      ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64')
      : undefined;

    return { items, nextCursor, hasMore: !!lastEvaluatedKey };
  }

  /**
   * Get a shared Agent (from any user).
   * Env values are stripped for security — non-owners must not see secrets.
   */
  async getSharedAgent(userId: UserId, agentId: AgentId): Promise<Agent | null> {
    // Raw read (no SSM resolution) since we strip env anyway.
    const agent = await this.repo.get(userId, agentId);

    if (!agent || !agent.isShared) {
      return null;
    }

    // Strip env values from mcpConfig for security.
    if (agent.mcpConfig) {
      agent.mcpConfig = stripEnvFromMcpConfig(agent.mcpConfig);
    }

    return agent;
  }

  /**
   * Clone a shared Agent into your own collection.
   * Env values are NOT copied — the target user must provide their own credentials.
   */
  async cloneAgent(
    targetUserId: UserId,
    sourceUserId: UserId,
    sourceAgentId: AgentId,
    targetUsername?: string
  ): Promise<Agent> {
    try {
      // Retrieve the original Agent (env already stripped by getSharedAgent)
      const sourceAgent = await this.getSharedAgent(sourceUserId, sourceAgentId);

      if (!sourceAgent) {
        throw new AgentNotFoundError('Shared agent not found');
      }

      // Create as a new Agent — mcpConfig already has env stripped
      const input: CreateAgentInput = {
        name: sourceAgent.name,
        description: sourceAgent.description,
        icon: sourceAgent.icon,
        systemPrompt: sourceAgent.systemPrompt,
        enabledTools: sourceAgent.enabledTools,
        scenarios: sourceAgent.scenarios.map((s) => ({
          title: s.title,
          prompt: s.prompt,
        })),
        mcpConfig: sourceAgent.mcpConfig,
        defaultStoragePath: sourceAgent.defaultStoragePath,
      };

      return await this.createAgent(targetUserId, input, targetUsername);
    } catch (error) {
      logger.error({ err: error }, 'Error cloning agent:');
      throw error;
    }
  }
}

/**
 * Create an AgentsService bound to runtime config: the env-bound
 * AgentsRepository singleton plus an SsmEnvStore for credential storage.
 */
export function createAgentsService(): AgentsService {
  return new AgentsService(
    getAgentsRepository(),
    new SsmEnvStore(config.SSM_PARAMETER_PREFIX, config.AWS_REGION)
  );
}
