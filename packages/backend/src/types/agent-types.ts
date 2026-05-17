/**
 * Agent domain type definitions
 * Extracted from services/agents-service.ts for layer separation
 */

import type { UserId, AgentId } from '@moca/core';

export interface MCPServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServer>;
}

export interface Scenario {
  id: string;
  title: string;
  prompt: string;
}

export interface Agent {
  userId: UserId;
  agentId: AgentId;
  name: string;
  description: string;
  icon?: string;
  systemPrompt: string;
  enabledTools: string[];
  scenarios: Scenario[];
  mcpConfig?: MCPConfig;
  defaultStoragePath?: string; // Default working directory for this agent
  createdAt: string;
  updatedAt: string;

  // Sharing-related
  isShared: boolean; // Sharing flag (visible to entire organization)
  createdBy: string; // Creator name (Cognito username)
}

/**
 * Agent type for DynamoDB storage
 * Converts isShared to string type (to accommodate GSI key constraints)
 */
export interface DynamoAgent extends Omit<Agent, 'isShared'> {
  isShared: string; // 'true' | 'false'
}

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

export interface UpdateAgentInput extends Partial<CreateAgentInput> {
  agentId: AgentId;
}

/**
 * Pagination result type definition
 */
export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}
