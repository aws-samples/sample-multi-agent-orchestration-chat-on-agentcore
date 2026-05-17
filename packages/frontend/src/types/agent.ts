/**
 * Agent-related type definitions
 */

import type { AgentId, UserId } from '@moca/core';

/**
 * MCP server configuration
 */
export interface MCPServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
}

/**
 * MCP Configuration
 */
export interface MCPConfig {
  mcpServers: Record<string, MCPServer>;
}

export interface Scenario {
  id: string;
  title: string; // Scenario name (e.g. "Code Review Request")
  prompt: string; // Prompt template
}

export interface Agent {
  /** Branded agent identifier (UUID). Kept in sync with backend `AgentId`. */
  agentId: AgentId;
  name: string; // Agent name
  description: string; // Description
  icon?: string; // Lucide icon name (e.g. "Bot", "Code", "Brain")
  systemPrompt: string; // System prompt
  enabledTools: string[]; // Array of enabled tool names
  scenarios: Scenario[]; // Frequently used prompts
  mcpConfig?: MCPConfig; // MCP server configuration
  defaultStoragePath?: string; // Default working directory for this agent
  createdAt: Date;
  updatedAt: Date;

  // Sharing-related
  isShared: boolean; // Shared flag (public to organization)
  createdBy: string; // Creator name (Cognito username)
  /**
   * Original owner's `UserId` — only populated when this record came from
   * the shared-agent API. Used when cloning a shared agent so the server
   * can locate the source owner's partition.
   */
  userId?: UserId;
}

/**
 * Input data for creating an agent
 */
export interface CreateAgentInput {
  name: string;
  description: string;
  icon?: string;
  systemPrompt: string;
  enabledTools: string[];
  scenarios: Omit<Scenario, 'id'>[];
  mcpConfig?: MCPConfig;
  defaultStoragePath?: string;
}

/**
 * Input data for updating an agent
 */
export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  agentId: AgentId;
}

/**
 * AgentStore state
 */
export interface AgentState {
  agents: Agent[];
  selectedAgent: Agent | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * AgentStore actions
 */
export interface AgentActions {
  // Agent CRUD (async)
  createAgent: (input: CreateAgentInput) => Promise<Agent>;
  updateAgent: (input: UpdateAgentInput) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  getAgent: (id: string) => Agent | undefined;

  // Share agent
  toggleShare: (id: string) => Promise<Agent>;

  // Select agent
  selectAgent: (agent: Agent | null) => void;

  // Initialization/reset (async)
  initializeStore: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  clearStore: () => void;
  clearError: () => void;
}

/**
 * Sort field options for agent list
 */
export type AgentSortField = 'name' | 'createdAt' | 'updatedAt';

/**
 * Sort order options
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Sort configuration for agent list
 */
export interface AgentSortConfig {
  field: AgentSortField;
  order: SortOrder;
}

/**
 * Complete type for AgentStore
 */
export type AgentStore = AgentState & AgentActions;
