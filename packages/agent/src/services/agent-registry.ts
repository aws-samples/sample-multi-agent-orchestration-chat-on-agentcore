/**
 * Agent Registry
 * Fetches agent definitions from backend API
 */

import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import { getCurrentContext } from '../libs/context/request-context.js';

/**
 * Agent definition structure
 */
export interface AgentDefinition {
  name: string;
  systemPrompt: string;
  enabledTools: string[];
  modelId?: string;
}

/**
 * Backend API response types
 */
interface BackendAgent {
  agentId: string;
  name: string;
  description: string;
  systemPrompt?: string;
  enabledTools?: string[];
  modelId?: string;
}

interface GetAgentResponse {
  agent: BackendAgent;
  metadata?: Record<string, unknown>;
}

interface ListAgentsResponse {
  agents: BackendAgent[];
  metadata?: Record<string, unknown>;
}

/**
 * Cache for agent definitions
 */
const agentCache = new Map<string, AgentDefinition>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

/**
 * Options for Backend API calls
 * Used to pass auth context explicitly when AsyncLocalStorage context is unavailable
 * (e.g., background sub-agent task execution)
 */
export interface AgentRegistryOptions {
  /** Authorization header (Bearer token) — overrides AsyncLocalStorage context */
  authHeader?: string;
  /** User ID for Machine User requests — sent as X-Target-User-Id header */
  userId?: string;
  /**
   * Cognito ID Token — overrides AsyncLocalStorage context.
   * Forwarded as X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token so the
   * Backend can resolve the Identity Pool identityId (required by authMiddleware).
   */
  idToken?: string;
}

/**
 * Build request headers for Backend API calls
 * Resolves auth header and ID Token from explicit options or AsyncLocalStorage context.
 *
 * The Backend `authMiddleware` requires BOTH a valid JWT Bearer token AND the
 * X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header, so we must forward
 * the caller's ID Token when invoking Backend APIs from within tools.
 */
function buildHeaders(options?: AgentRegistryOptions): Record<string, string> {
  const context = getCurrentContext();
  const authHeader = options?.authHeader || context?.authorizationHeader;
  const idToken = options?.idToken || context?.idToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }
  if (idToken) {
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'] = idToken;
  }
  if (options?.userId) {
    headers['X-Target-User-Id'] = options.userId;
  }
  return headers;
}

/**
 * Fetch agent definition from backend API by agentId
 */
export async function getAgentDefinition(
  agentId: string,
  options?: AgentRegistryOptions
): Promise<AgentDefinition | null> {
  // Check cache
  const cached = agentCache.get(agentId);
  const cacheTime = cacheTimestamps.get(agentId);

  if (cached && cacheTime && Date.now() - cacheTime < CACHE_TTL) {
    logger.info({ agentId }, 'Using cached agent definition:');
    return cached;
  }

  try {
    const url = `${config.BACKEND_API_URL}/agents/${encodeURIComponent(agentId)}`;

    const headers = buildHeaders(options);

    logger.info(
      {
        agentId,
        url,
        hasAuth: !!headers['Authorization'],
        hasIdToken: !!headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'],
        hasTargetUserId: !!headers['X-Target-User-Id'],
      },
      'Fetching agent definition:'
    );

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn({ agentId }, 'Agent not found:');
        return null;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as GetAgentResponse | BackendAgent;

    // Extract agent from response (backend returns { agent: {...}, metadata: {...} })
    const agent = 'agent' in data ? data.agent : data;

    if (!agent) {
      logger.warn({ agentId }, 'Agent not found in response:');
      return null;
    }

    // Map backend agent structure to AgentDefinition
    const definition: AgentDefinition = {
      name: agent.name,
      systemPrompt: agent.systemPrompt || '',
      enabledTools: agent.enabledTools || [],
      modelId: agent.modelId,
    };

    // Cache the result
    agentCache.set(agentId, definition);
    cacheTimestamps.set(agentId, Date.now());

    logger.info(
      {
        agentId,
        tools: definition.enabledTools.length,
      },
      'Agent definition fetched and cached:'
    );

    return definition;
  } catch (error) {
    logger.error(
      {
        agentId,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to fetch agent definition:'
    );
    return null;
  }
}

/**
 * List all available agents with simplified information
 */
export async function listAgents(
  options?: AgentRegistryOptions
): Promise<Array<{ agentId: string; name: string; description: string }>> {
  try {
    const url = `${config.BACKEND_API_URL}/agents`;

    const headers = buildHeaders(options);

    logger.info(
      {
        url,
        hasAuth: !!headers['Authorization'],
        hasIdToken: !!headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'],
        hasTargetUserId: !!headers['X-Target-User-Id'],
      },
      'Fetching agent list:'
    );

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as ListAgentsResponse;

    // Backend returns { agents: [...], metadata: {...} }
    const agents = data.agents || [];

    return agents.map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      description: agent.description,
    }));
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to list agents:'
    );
    return [];
  }
}
