/**
 * Authentication type definitions
 * Extracted from middleware/auth.ts for layer separation
 */

import { Request } from 'express';
import type { IdentityId } from '@moca/core';

/**
 * JWT payload type definition for Cognito tokens
 */
export interface CognitoJWTPayload {
  /** Subject */
  sub?: string;
  /** Issuer */
  iss?: string;
  /** Audience */
  aud?: string | string[];
  /** Expiration Time */
  exp?: number;
  /** Issued At */
  iat?: number;
  /** JWT ID */
  jti?: string;
  /** Cognito Username */
  'cognito:username'?: string;
  /** Username (Access Token) */
  username?: string;
  /** Email */
  email?: string;
  /** Token Use (access or id) */
  token_use?: 'access' | 'id';
  /** Client ID */
  client_id?: string;
  /** OAuth Scopes (space-separated, for machine users) */
  scope?: string;
  /** Cognito Groups */
  'cognito:groups'?: string[];
  /** Auth Time */
  auth_time?: number;
}

/**
 * JWT verification result type definition
 */
export interface JWTVerificationResult {
  /** Verification success flag */
  valid: boolean;
  /** Decoded payload */
  payload?: CognitoJWTPayload;
  /** Error message */
  error?: string;
  /** Error details */
  details?: unknown;
}

/**
 * Authenticated request type definition
 * Add JWT information to Express Request object
 */
export interface AuthenticatedRequest extends Request {
  /** JWT payload (access token — cryptographically verified). */
  jwt?: CognitoJWTPayload;
  /**
   * Verified Cognito User Pool ID token payload. Present only when the
   * frontend forwarded an ID token via the custom header AND it passed
   * JWKS / `aud` / `exp` / `token_use` verification AND
   * `idPayload.sub === jwt.sub` (token-confusion defence). Machine-user
   * flows never populate this field because Client Credentials Flow does
   * not emit an ID token. Event-driven Trigger Lambda flows forward a
   * developer-auth openIdToken instead; that token type is not
   * verifiable against the User Pool JWKS so `idPayload` stays
   * undefined for those requests.
   */
  idPayload?: CognitoJWTPayload;
  /** User ID (Cognito User Pool sub UUID) */
  userId?: string;
  /**
   * Cognito Identity Pool identityId (format: "REGION:uuid").
   * Populated by `authMiddleware` when the caller forwards the Cognito ID
   * Token in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`. Used as the
   * storage key (S3 prefix, DynamoDB partition key, AgentCore Memory actorId).
   * Undefined for machine-user tokens that do not supply the ID Token header.
   */
  identityId?: IdentityId;
  /** Request ID (for log tracking) */
  requestId?: string;
}

/**
 * Authentication information type definition
 */
export interface AuthInfo {
  authenticated: boolean;
  userId?: string;
  username?: string;
  email?: string;
  groups: string[];
  tokenUse?: 'access' | 'id';
  requestId?: string;
  /** Whether the token is from a machine user (Client Credentials Flow) */
  isMachineUser: boolean;
  /** Client ID (for machine users) */
  clientId?: string;
  /** OAuth scopes (for machine users) */
  scopes?: string[];
}

/**
 * Authentication error response type definition
 */
export interface AuthErrorResponse {
  error: string;
  message: string;
  code: string;
  timestamp: string;
  requestId?: string;
}
