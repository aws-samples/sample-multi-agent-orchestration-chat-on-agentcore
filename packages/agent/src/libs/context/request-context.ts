/**
 * Request Context Management
 * Request-scoped context management
 */

import { AsyncLocalStorage } from 'async_hooks';
import { v7 as uuidv7 } from 'uuid';
import type { IdentityId, SessionId, UserId } from '@moca/core';
import type { IWorkspaceSync, SessionType } from '../../types/index.js';
import type { VerifiedAccessTokenPayload, VerifiedIdTokenPayload } from '../auth/jwt-verifier.js';

/**
 * Type definition for request context
 */
export interface RequestContext {
  /** Authorization header (JWT Bearer Token) */
  authorizationHeader?: string;
  /**
   * Cognito User Pool `sub` UUID (Branded).
   * Populated by `authResolverMiddleware` once the request has been
   * authenticated. Remains `undefined` for unauthenticated / pre-auth
   * code paths (e.g. during `/ping`).
   */
  userId?: UserId;
  /**
   * S3 directory path selected by the user. Always populated — defaults
   * to `'/'` in `createRequestContext` and is overridden by
   * `authResolverMiddleware` when the request body specifies a path. Not
   * optional so that downstream code can rely on a non-null value
   * without repeating the `|| '/'` fallback.
   */
  storagePath: string;
  /** Workspace sync service */
  workspaceSync?: IWorkspaceSync;
  /** Request-specific ID (for log tracing) */
  requestId: string;
  /** Request start time */
  startTime: Date;
  /** Whether this is a machine user (Client Credentials Flow) */
  isMachineUser: boolean;
  /** Client ID (for machine users) */
  clientId?: string;
  /** OAuth scopes */
  scopes?: string[];
  /**
   * Cognito ID Token forwarded from the frontend via
   * X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header.
   * Used by scoped-credentials.ts to call GetCredentialsForIdentity
   * against the Cognito Identity Pool and obtain per-user temporary credentials.
   * Undefined for machine users (Client Credentials Flow has no ID token).
   */
  idToken?: string;
  /**
   * Cognito Identity Pool Identity ID (format: "REGION:uuid").
   * Resolved by cognito-identity:GetId using the ID Token.
   * Used as the S3 prefix key and DynamoDB partition key for per-user storage.
   * Populated by scoped-credentials.ts on first credential request.
   * Undefined until first credential exchange; undefined for machine users.
   */
  identityId?: IdentityId;
  /** Session ID (from x-amzn-bedrock-agentcore-runtime-session-id header) — validated Branded type */
  sessionId?: SessionId;
  /** Session type (from x-amzn-bedrock-agentcore-runtime-session-type header) */
  sessionType?: SessionType;
  /**
   * Verified access token payload. Populated by
   * `requestContextMiddleware` after successful JWKS / claims
   * verification. Downstream code should read `sub`, `client_id`,
   * `scope`, etc. from here rather than re-parsing the raw JWT; this is
   * the only source that has been cryptographically validated.
   */
  accessTokenPayload?: VerifiedAccessTokenPayload;
  /**
   * Verified ID token payload. Present only for regular-user requests
   * where the frontend forwarded a Cognito User Pool ID token via
   * `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`. Machine-user
   * flows and developer-auth flows (Trigger Lambda) leave this
   * `undefined` because those ID tokens are not minted by the User
   * Pool and are validated by Cognito Identity Pool instead.
   */
  idTokenPayload?: VerifiedIdTokenPayload;
}

/**
 * Retrieve the current `UserId` from the request context, throwing if
 * it has not been populated yet. Callers that run after
 * `authResolverMiddleware` should prefer this over raw context access
 * because the `UserId` brand carries the guarantee that the string
 * matches the Cognito `sub` UUID shape.
 */
export function requireUserId(): UserId {
  const ctx = getCurrentContext();
  if (!ctx?.userId) {
    throw new Error(
      'RequestContext.userId is not populated. Ensure authResolverMiddleware has run.'
    );
  }
  return ctx.userId;
}

/**
 * Retrieve the current `IdentityId` from the request context, throwing
 * if it has not been populated yet. Data-access sites (DynamoDB, S3,
 * AgentCore Memory) must use the identityId as the partition / actor key.
 * By requiring the branded type here we stop string-typed `userId`
 * values from silently flowing into storage paths.
 */
export function requireIdentityId(): IdentityId {
  const ctx = getCurrentContext();
  if (!ctx?.identityId) {
    throw new Error(
      'RequestContext.identityId is not populated. Ensure identityResolverMiddleware has run.'
    );
  }
  return ctx.identityId;
}

/**
 * Type definition for context metadata
 */
export interface ContextMetadata {
  /** Request-specific ID */
  requestId: string;
  /** User ID (if present) */
  userId?: string;
  /** Whether authentication header is present */
  hasAuth: boolean;
  /** Request processing time (in milliseconds) */
  duration: number;
}

/**
 * Request context management using AsyncLocalStorage
 * Propagate authentication information in Express request scope
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context
 */
export function getCurrentContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Create a new request context
 */
export function createRequestContext(authorizationHeader?: string): RequestContext {
  return {
    authorizationHeader,
    requestId: uuidv7(),
    startTime: new Date(),
    isMachineUser: false,
    // Defaulting here keeps the `storagePath` invariant ("always populated
    // once a RequestContext exists") expressed in the type. The
    // authResolverMiddleware overrides it from the request body when a
    // path is provided.
    storagePath: '/',
  };
}

/**
 * Execute a callback function with request context
 */
export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(context, callback);
}

/**
 * Get metadata for request context logging
 */
export function getContextMetadata(): ContextMetadata {
  const context = getCurrentContext();
  if (!context) {
    return {
      requestId: 'unknown',
      hasAuth: false,
      duration: 0,
    };
  }

  return {
    requestId: context.requestId,
    userId: context.userId,
    hasAuth: !!context.authorizationHeader,
    duration: Date.now() - context.startTime.getTime(),
  };
}
