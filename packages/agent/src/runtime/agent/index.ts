/**
 * Agent creation module
 *
 * Re-exports all agent building blocks and types.
 */

// Types
export type {
  CreateAgentOptions,
  CreateAgentResult,
  AgentMetadata,
  MemoryConditions,
  LongTermMemoryParams,
  LongTermMemoryResult,
} from './types.js';

// Builders
export { buildUserMCPClients } from './mcp-clients-builder.js';
export { selectEnabledTools, buildToolSet } from './tools-builder.js';
export type { ToolSetResult } from './tools-builder.js';
export { extractMemoryParams, fetchLongTermMemories } from './memory-fetcher.js';
export { loadSessionHistory } from './session-loader.js';
