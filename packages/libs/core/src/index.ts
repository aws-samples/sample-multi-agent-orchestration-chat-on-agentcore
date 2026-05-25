/**
 * @moca/core — Core types, branded IDs, and shared utilities for Moca
 *
 * @example
 * ```ts
 * import { generateSessionId, parseSessionId, isSessionId } from '@moca/core';
 * import type { SessionId, Brand } from '@moca/core';
 *
 * // Generate a new session ID
 * const id: SessionId = generateSessionId();
 *
 * // Validate external input
 * const parsed: SessionId = parseSessionId(headerValue);
 *
 * // Type guard
 * if (isSessionId(unknownValue)) { ... }
 * ```
 */

// Branded Type infrastructure
export type { Brand } from './branded.js';

// SessionId
export type { SessionId } from './session-id.js';
export {
  generateSessionId,
  isSessionId,
  parseSessionId,
  SESSION_ID_LENGTH,
  SESSION_ID_PATTERN,
} from './session-id.js';

// UserId
export type { UserId } from './user-id.js';
export { isUserId, parseUserId, USER_ID_PATTERN } from './user-id.js';

// IdentityId
export type { IdentityId } from './identity-id.js';
export { isIdentityId, parseIdentityId, IDENTITY_ID_PATTERN } from './identity-id.js';

// AgentId
export type { AgentId } from './agent-id.js';
export { isAgentId, parseAgentId, AGENT_ID_PATTERN } from './agent-id.js';

// TriggerId
export type { TriggerId } from './trigger-id.js';
export { isTriggerId, parseTriggerId, TRIGGER_ID_PATTERN } from './trigger-id.js';

// Crypto utilities
export { getSecureRandomBytes } from './crypto.js';

// System IDs (well-known identifiers for default/system agents)
export { SYSTEM_USER_ID } from './system-ids.js';

// Bedrock model definitions — Single Source of Truth
export type { BedrockModelDefinition } from './bedrock-models.js';
export { BEDROCK_MODEL_DEFINITIONS, getMaxOutputTokens } from './bedrock-models.js';
