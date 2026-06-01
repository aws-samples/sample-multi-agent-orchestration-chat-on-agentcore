/**
 * Combined Authentication Middleware
 *
 * Every protected backend route is expected to be invoked by a
 * browser-authenticated user, so this middleware enforces ALL of the
 * following and rejects with 401 on failure:
 *
 *   1. Valid Cognito access token in `Authorization: Bearer ...`
 *      (JWKS signature + `iss` + `aud` allow-list + `exp` +
 *      `token_use === 'access'`). Populates `req.jwt` / `req.userId`.
 *   2. Valid Cognito ID token in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`
 *      for regular users (same checks plus `aud === frontend client_id`).
 *      Populates `req.idPayload`. Machine users and event-driven Trigger
 *      Lambda requests do NOT provide this token.
 *   3. `access.sub === id.sub` when both tokens are present. Defeats the
 *      token-confusion attack (pairing user B's access token with user
 *      A's ID token), which would otherwise let B authenticate as B but
 *      receive A's Identity-Pool-scoped credentials via
 *      `GetCredentialsForIdentity`.
 *   4. Identity Pool identityId resolution via `resolveIdentityId`.
 *      Populates `req.identityId`, used as the partition key for
 *      per-user storage (S3 / DynamoDB / AgentCore Memory).
 *
 * Token-type branching
 * --------------------
 * The backend sees three distinct caller profiles:
 *   - Frontend user: access token + UserPool ID token. All checks apply.
 *   - Machine user (Client Credentials Flow): access token only. ID token
 *     header is absent; identityId resolution is skipped (these callers
 *     are service-level and do not own user storage).
 *   - Event-driven Trigger Lambda: machine-user access token + developer-auth
 *     openIdToken (iss=cognito-identity.amazonaws.com). The openIdToken
 *     cannot be verified with the User Pool JWKS; its validation is
 *     delegated to `resolveIdentityId` / Cognito Identity Pool.
 */

import { Response, NextFunction } from 'express';
import { isUserId, parseUserId, type UserId } from '@moca/core';
import { verifyJWT, verifyIdToken, extractJWTFromHeader } from '../libs/auth/index.js';
import { resolveIdentityId } from '../libs/auth/identity-resolver.js';
import { AppError, ErrorCode } from '../libs/http/index.js';
import type {
  CognitoJWTPayload,
  AuthenticatedRequest,
  AuthInfo,
  AuthErrorResponse,
} from '../types/index.js';
import { logger } from '../libs/logger/index.js';

// Re-export types for backward compatibility
export type { AuthenticatedRequest, AuthInfo } from '../types/index.js';

/**
 * Generate authentication error response
 */
function createAuthErrorResponse(
  code: string,
  message: string,
  requestId: string
): AuthErrorResponse {
  return {
    // 401 reason phrase — aligned with ERROR_CODE_REASON[UNAUTHENTICATED] in
    // the shared HTTP helpers so the auth envelope matches the canonical one.
    // The specific `code` values (MISSING_AUTHORIZATION, INVALID_JWT, ...) are
    // intentionally preserved because the frontend branches on them.
    error: 'Unauthorized',
    message,
    code,
    requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Heuristic: detect tokens minted by `GetOpenIdTokenForDeveloperIdentity`
 * (Cognito Identity Pool). These tokens carry
 * `iss=https://cognito-identity.amazonaws.com` and their `sub` claim encodes
 * the identityId directly (`REGION:UUID`). They CANNOT be verified against
 * the Cognito User Pool JWKS — validation is deferred to Cognito Identity
 * Pool when `resolveIdentityId` is invoked downstream.
 *
 * We peek at the unverified payload only to decide which verifier to run;
 * no claim is trusted on the strength of this check alone.
 */
function looksLikeDeveloperAuthToken(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >;
    const iss = payload.iss;
    return typeof iss === 'string' && iss.includes('cognito-identity.amazonaws.com');
  } catch {
    return false;
  }
}

/**
 * Combined authentication middleware.
 * See file-level comment for the full contract.
 */
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // `requestLoggerMiddleware` (mounted before the routers) already minted the
  // request id onto `req.requestId`. Fall back to a placeholder only for unit
  // tests that invoke this middleware without the upstream logger.
  const requestId = req.requestId ?? 'unknown';

  // (1) Authorization header presence
  const authHeader = req.get('Authorization');
  if (!authHeader) {
    logger.warn('Authorization header not set (%s)', requestId);
    res
      .status(401)
      .json(
        createAuthErrorResponse(
          'MISSING_AUTHORIZATION',
          'Authorization header is required',
          requestId
        )
      );
    return;
  }

  const token = extractJWTFromHeader(authHeader);
  if (!token) {
    logger.warn('Invalid Authorization header format (%s)', requestId);
    res
      .status(401)
      .json(
        createAuthErrorResponse(
          'INVALID_AUTHORIZATION_FORMAT',
          'Authorization header must be in "Bearer <token>" format',
          requestId
        )
      );
    return;
  }

  // (2) Access token verification
  verifyJWT(token)
    .then(async (accessResult) => {
      if (!accessResult.valid || !accessResult.payload) {
        logger.warn({ requestId, err: accessResult.error }, 'JWT verification failed');
        res
          .status(401)
          .json(
            createAuthErrorResponse(
              'INVALID_JWT',
              accessResult.error || 'JWT verification failed',
              requestId
            )
          );
        return;
      }

      const accessPayload = accessResult.payload;
      req.jwt = accessPayload;
      req.userId = accessPayload.sub || accessPayload['cognito:username'];

      // (3) ID token header — required for regular users, skipped for
      //     machine users and event-driven Trigger Lambda requests.
      const idToken = req.get('X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token');
      if (!idToken) {
        logger.warn('ID Token header missing (%s)', requestId);
        res
          .status(401)
          .json(
            createAuthErrorResponse(
              'MISSING_ID_TOKEN',
              'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header is required',
              requestId
            )
          );
        return;
      }

      // (4) ID token verification — ONLY for User Pool ID tokens.
      //     Developer-auth openIdTokens use a different issuer and JWKS;
      //     they are validated downstream by Cognito Identity Pool when
      //     `resolveIdentityId` calls `GetCredentialsForIdentity`.
      const isDeveloperAuthToken = looksLikeDeveloperAuthToken(idToken);
      if (!isDeveloperAuthToken) {
        const idResult = await verifyIdToken(idToken);
        if (!idResult.valid || !idResult.payload) {
          logger.warn({ requestId, err: idResult.error }, 'ID token verification failed');
          res
            .status(401)
            .json(
              createAuthErrorResponse(
                'INVALID_ID_TOKEN',
                idResult.error || 'ID token verification failed',
                requestId
              )
            );
          return;
        }

        const idPayload = idResult.payload;

        // (5) Token-confusion defence: both tokens must describe the
        //     same Cognito user. If `access.sub` and `id.sub` disagree,
        //     reject regardless of how each token individually verified.
        if (accessPayload.sub && idPayload.sub && accessPayload.sub !== idPayload.sub) {
          logger.warn(
            {
              requestId,
              accessSub: accessPayload.sub,
              idSub: idPayload.sub,
              accessClientId: accessPayload.client_id,
              idAud: idPayload.aud,
            },
            'Token-confusion attempt: access_token.sub !== id_token.sub'
          );
          res
            .status(401)
            .json(
              createAuthErrorResponse(
                'TOKEN_SUBJECT_MISMATCH',
                'Access token and ID token subjects do not match',
                requestId
              )
            );
          return;
        }

        req.idPayload = idPayload;
      }

      // (6) Identity Pool identityId resolution. For UserPool tokens this
      //     performs `GetId`; for developer-auth tokens the identityId is
      //     read from the verified `sub` claim inside
      //     `resolveIdentityId` (see identity-resolver.ts for the
      //     branching contract).
      try {
        req.identityId = await resolveIdentityId(idToken);
      } catch (error) {
        logger.error({ err: error, requestId }, 'Failed to resolve identityId');
        res
          .status(401)
          .json(
            createAuthErrorResponse(
              'INVALID_ID_TOKEN',
              error instanceof Error ? error.message : 'Failed to resolve Identity Pool identityId',
              requestId
            )
          );
        return;
      }

      next();
    })
    .catch((error) => {
      logger.error({ err: error }, 'JWT verification error (%s):', requestId);
      res
        .status(500)
        .json(
          createAuthErrorResponse(
            'JWT_VERIFICATION_ERROR',
            'Internal error during JWT verification',
            requestId
          )
        );
    });
}

/**
 * Determine if the JWT token is from a machine user (Client Credentials Flow)
 *
 * Client Credentials Flow characteristics:
 * 1. No username or cognito:username claim
 * 2. sub claim is either missing or equals client_id
 * 3. token_use is 'access'
 *
 * Regular user tokens (Authorization Code Flow):
 * - Have cognito:username or username claim
 * - sub claim contains user UUID (different from client_id)
 * - Can be either 'access' or 'id' token_use
 */
function isMachineUserToken(payload?: CognitoJWTPayload): boolean {
  if (!payload) return false;

  // Check for user identifier claims
  const hasUserIdentifier = payload['cognito:username'] || payload['username'];

  // Check if sub exists and is different from client_id
  // For regular users: sub is a UUID different from client_id
  // For machine users: sub is either missing or equals client_id
  const hasUserSub = payload.sub && payload.sub !== payload.client_id;

  // If has user identifier or valid user sub, it's a regular user
  if (hasUserIdentifier || hasUserSub) {
    return false;
  }

  // Machine user: no user identifiers and token_use is 'access'
  return payload.token_use === 'access';
}

/**
 * Helper function to get current authentication information
 */
export function getCurrentAuth(req: AuthenticatedRequest): AuthInfo {
  const payload = req.jwt;
  const machineUser = isMachineUserToken(payload);

  return {
    authenticated: !!payload,
    userId: machineUser ? undefined : req.userId,
    username: payload?.['cognito:username'] || payload?.username,
    email: payload?.email,
    groups: payload?.['cognito:groups'] || [],
    tokenUse: payload?.token_use,
    requestId: req.requestId,
    isMachineUser: machineUser,
    clientId: machineUser ? payload?.client_id : undefined,
    scopes: payload?.scope?.split(' '),
  };
}

/**
 * Resolve the authenticated caller's branded `UserId`, throwing an
 * `AppError(UNAUTHENTICATED)` if it cannot be determined (e.g. a machine-user
 * token with no resolvable user). Route handlers use this so they no longer
 * need the `auth.userId ? parseUserId(...) : 400` boilerplate — the throw is
 * rendered by `errorHandlerMiddleware`.
 *
 * Note: routes that must also support machine users acting on behalf of
 * another user (via the `X-Target-User-Id` header) mount the
 * `resolveTargetUser` middleware instead and read `req.targetUserId`.
 */
export function requireUserId(req: AuthenticatedRequest): UserId {
  const auth = getCurrentAuth(req);
  if (!auth.userId) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Failed to retrieve user ID');
  }
  return parseUserId(auth.userId);
}

/**
 * Middleware that resolves the effective target `UserId` onto
 * `req.targetUserId`, supporting machine-user impersonation:
 *
 *   - Regular users: the caller's own JWT `sub`.
 *   - Machine users (Client Credentials Flow): the `X-Target-User-Id` header,
 *     which lets EventBridge-triggered agents read/write agent definitions on
 *     behalf of a target user. The header must be a valid Cognito `sub` UUID.
 *
 * Throws `AppError` (rendered by `errorHandlerMiddleware`) on failure:
 *   - UNAUTHENTICATED when a regular user has no resolvable `userId`.
 *   - VALIDATION_ERROR when a machine user omits / malforms the header.
 *
 * Mount this before the route handler; the handler then reads the
 * already-resolved `req.targetUserId` instead of re-deriving the identity.
 */
export function resolveTargetUser(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const auth = getCurrentAuth(req);

  if (auth.isMachineUser) {
    const headerValue = req.headers['x-target-user-id'];
    const targetUserId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!targetUserId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'X-Target-User-Id header is required for machine user requests'
      );
    }
    if (!isUserId(targetUserId)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'X-Target-User-Id must be a valid UUID format'
      );
    }
    req.targetUserId = parseUserId(targetUserId);
    next();
    return;
  }

  if (!auth.userId) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Failed to retrieve user ID');
  }
  req.targetUserId = parseUserId(auth.userId);
  next();
}
