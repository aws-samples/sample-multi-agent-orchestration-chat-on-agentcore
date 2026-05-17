/**
 * Agent Management API Client
 */

import { backendClient } from './client/backend-client';
import type { Agent, CreateAgentInput } from '../types/agent';

export interface AgentResponse {
  agent: Agent;
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
  };
}

export interface AgentsListResponse {
  agents: Agent[];
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
    count: number;
  };
}

export interface SharedAgentsResponse {
  agents: Agent[];
  nextCursor?: string;
  hasMore: boolean;
  metadata: {
    requestId: string;
    timestamp: string;
    count: number;
  };
}

export interface InitializeAgentsResponse {
  agents: Agent[];
  skipped: boolean;
  message?: string;
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
    count: number;
  };
}

/**
 * Parse agent dates from API response
 */
function parseAgentDates(agent: Agent): Agent {
  return {
    ...agent,
    createdAt: new Date(agent.createdAt),
    updatedAt: new Date(agent.updatedAt),
  };
}

/**
 * Get list of user's agents
 */
export async function listAgents(): Promise<Agent[]> {
  const data = await backendClient.get<AgentsListResponse>('/agents');
  return data.agents.map(parseAgentDates);
}

/**
 * Get a specific agent
 */
export async function getAgent(agentId: string): Promise<Agent> {
  const data = await backendClient.get<AgentResponse>(`/agents/${agentId}`);
  return parseAgentDates(data.agent);
}

/**
 * Create a new agent
 */
export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const data = await backendClient.post<AgentResponse>('/agents', input);
  return parseAgentDates(data.agent);
}

/**
 * Update an existing agent
 */
export async function updateAgent(
  agentId: string,
  input: Partial<CreateAgentInput>
): Promise<Agent> {
  const data = await backendClient.put<AgentResponse>(`/agents/${agentId}`, input);
  return parseAgentDates(data.agent);
}

/**
 * Delete an agent
 */
export async function deleteAgent(agentId: string): Promise<void> {
  return backendClient.delete<void>(`/agents/${agentId}`);
}

/**
 * Toggle agent share status
 */
export async function toggleShareAgent(agentId: string): Promise<Agent> {
  const data = await backendClient.put<AgentResponse>(`/agents/${agentId}/share`);
  return parseAgentDates(data.agent);
}

/**
 * List shared agents (with pagination support)
 */
export async function listSharedAgents(
  searchQuery?: string,
  limit?: number,
  cursor?: string
): Promise<SharedAgentsResponse> {
  const params = new URLSearchParams();
  if (searchQuery) params.append('q', searchQuery);
  if (limit) params.append('limit', limit.toString());
  if (cursor) params.append('cursor', cursor);

  const queryString = params.toString();
  const url = `/agents/shared-agents/list${queryString ? `?${queryString}` : ''}`;

  const data = await backendClient.get<SharedAgentsResponse>(url);

  return {
    ...data,
    agents: data.agents.map(parseAgentDates),
  };
}

/**
 * Get shared agent details
 */
export async function getSharedAgent(userId: string, agentId: string): Promise<Agent> {
  const data = await backendClient.get<AgentResponse>(`/agents/shared-agents/${userId}/${agentId}`);
  return parseAgentDates(data.agent);
}

/**
 * Clone shared agent to my agents
 */
export async function cloneSharedAgent(userId: string, agentId: string): Promise<Agent> {
  const data = await backendClient.post<AgentResponse>(
    `/agents/shared-agents/${userId}/${agentId}/clone`
  );

  return parseAgentDates(data.agent);
}

/**
 * Initialize default agents for first-time users
 * Creates default agents if user has no agents yet
 */
export async function initializeAgents(): Promise<InitializeAgentsResponse> {
  const data = await backendClient.post<InitializeAgentsResponse>('/agents/initialize');
  return {
    ...data,
    agents: data.agents.map(parseAgentDates),
  };
}
