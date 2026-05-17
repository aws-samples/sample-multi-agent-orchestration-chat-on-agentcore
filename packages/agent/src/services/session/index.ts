/**
 * Exports for session management functionality
 *
 * Session storage is created per-request by `setupSession` in `session-helper.ts`
 * using Cognito Identity Pool credentials for the authenticated user. There is
 * no longer a module-level shared storage instance — every caller must obtain
 * its storage via `setupSession` so that AgentCore Memory operations run under
 * per-user IAM conditions.
 */

export type { SessionConfig, SessionStorage } from './types.js';
export { FileSessionStorage } from './file-session-storage.js';
export { AgentCoreMemoryStorage } from './agentcore-memory-storage.js';
export { SessionPersistenceHook } from './session-persistence-hook.js';
export { retrieveLongTermMemory } from './memory-retriever.js';
