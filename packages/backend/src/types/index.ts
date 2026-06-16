/**
 * Backend types module exports
 * Layer 0: Type Definitions
 */

// Agent domain types
export type {
  MCPServer,
  MCPConfig,
  Scenario,
  Agent,
  DynamoAgent,
  CreateAgentInput,
  UpdateAgentInput,
  PaginatedResult,
} from './agent-types.js';
// Agent domain errors (value export — used with `throw` / `instanceof`)
export { AgentNotFoundError } from './agent-types.js';

// Authentication types
export type {
  CognitoJWTPayload,
  JWTVerificationResult,
  AuthenticatedRequest,
  AuthInfo,
  AuthErrorResponse,
} from './auth-types.js';
