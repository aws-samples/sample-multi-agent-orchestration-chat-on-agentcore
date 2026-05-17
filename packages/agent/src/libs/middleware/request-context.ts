/**
 * Request Context Middleware
 *
 * Express middleware that performs the *first* security-relevant step of
 * every `/invocations` request:
 *
 *   1. Verify the incoming Cognito access token (JWKS signature,
 *      `iss`, `aud` / `client_id`, `exp`, `token_use`).
 *   2. For regular-user requests, verify the accompanying ID token
 *      (same checks, plus `aud === COGNITO_USER_POOL_CLIENT_ID`).
 *   3. Assert `accessToken.sub === idToken.sub` to defeat the
 *      token-confusion attack (pairing user B's access token with
 *      user A's ID token).
 *   4. Populate `RequestContext` with verified claims — downstream code
 *      must read `userId` / `clientId` / `scopes` from here rather than
 *      re-parsing the raw JWT.
 *
 * For machine-user requests (Client Credentials Flow), the access token
 * verifier accepts the machine-user App Client; there is no ID token to
 * verify because the Client Credentials grant never issues one.
 *
 * For event-driven Trigger invocations (`openIdToken` from
 * `GetOpenIdTokenForDeveloperIdentity`), the ID token is issued by
 * Cognito Identity Pool, not the User Pool. We cannot verify it with
 * the User Pool's JWKS — instead we forward it verbatim to
 * `GetCredentialsForIdentity`, which performs its own validation. In
 * that case we skip User-Pool ID-token verification but still require a
 * valid machine-user access token.
 */

import { NextFunction, Request, Response } from 'express';

import { isSessionId, isUserId, type UserId } from '@moca/core';
import {
  classifyAccessToken,
  JwtVerificationError,
  verifyAccessToken,
  verifyIdToken,
  type VerifiedAccessTokenPayload,
  type VerifiedIdTokenPayload,
} from '../auth/jwt-verifier.js';
import { createRequestContext, runWithContext } from '../context/request-context.js';
import { logger } from '../logger/index.js';
import type { SessionType } from '../../types/index.js';

/**
 * Case-insensitive header access. Express normalises headers to
 * lowercase but keeping this helper centralises the lookup so tests can
 * exercise either casing.
 */
function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

/**
 * Heuristic: detect tokens minted by `GetOpenIdTokenForDeveloperIdentity`
 * (Cognito Identity Pool), which cannot be verified with the User Pool
 * JWKS. These tokens have `iss = "https://cognito-identity.amazonaws.com"`
 * and their `sub` claim encodes the identityId directly (`REGION:UUID`).
 *
 * We peek at the unverified header / payload without trusting any
 * claim — the token still has to satisfy Cognito Identity Pool's own
 * `GetCredentialsForIdentity` validation before any credential is
 * issued. The only decision we make here is "do we run User-Pool ID
 * token verification or not".
 */
function looksLikeDeveloperAuthToken(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }
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

async function verifyTokens(
  accessTokenRaw: string,
  idTokenRaw: string | undefined
): Promise<{
  accessPayload: VerifiedAccessTokenPayload;
  idPayload?: VerifiedIdTokenPayload;
  isMachineUser: boolean;
  skippedIdTokenVerification: boolean;
}> {
  const accessPayload = await verifyAccessToken(accessTokenRaw);
  const { isMachineUser } = classifyAccessToken(accessPayload);

  // Machine-user flows never produce an ID token. Trigger Lambda
  // forwards a developer-auth openIdToken in the same header — we leave
  // that for Cognito Identity Pool to validate.
  if (isMachineUser) {
    return { accessPayload, isMachineUser, skippedIdTokenVerification: true };
  }

  // Regular user: ID token is mandatory. Without it we cannot assert
  // token-confusion defence, and the scoped-credentials exchange
  // requires a UserPool ID token anyway.
  if (!idTokenRaw) {
    throw new JwtVerificationError(
      401,
      'ID token is required for user sessions (X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token)'
    );
  }

  // Developer-auth tokens cannot be verified against the UserPool JWKS.
  // Only the Trigger Lambda path uses these, and it always pairs them
  // with a machine-user access token — so reaching this branch means
  // something upstream misrouted a token. Fail closed.
  if (looksLikeDeveloperAuthToken(idTokenRaw)) {
    throw new JwtVerificationError(
      401,
      'Developer-auth openIdToken is not valid for a regular-user access token'
    );
  }

  const idPayload = await verifyIdToken(idTokenRaw);

  // Token-confusion defence: both tokens must describe the same Cognito
  // user. Without this check an attacker could pair user B's access
  // token (which passes authorizer because B is authenticated) with
  // user A's leaked ID token, causing the runtime to exchange A's ID
  // token for A's Identity Pool credentials while request-context
  // thinks the caller is B.
  if (accessPayload.sub !== idPayload.sub) {
    logger.warn(
      {
        accessSub: accessPayload.sub,
        idSub: idPayload.sub,
        accessClientId: accessPayload.client_id,
        idAud: idPayload.aud,
      },
      'Token-confusion attempt: access_token.sub !== id_token.sub'
    );
    throw new JwtVerificationError(401, 'Access token and ID token subjects do not match');
  }

  return { accessPayload, idPayload, isMachineUser, skippedIdTokenVerification: false };
}

/**
 * Express middleware that verifies incoming JWTs and seeds
 * `RequestContext` with the resulting claims.
 *
 * Errors are surfaced as HTTP responses here rather than being thrown
 * into the global error handler, because this middleware owns the
 * AsyncLocalStorage scope: throwing before `runWithContext` would leave
 * the error handler without a `requestId` to log.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader =
    getHeader(req, 'authorization') ||
    getHeader(req, 'x-amzn-bedrock-agentcore-runtime-custom-authorization');

  const requestContext = createRequestContext(authHeader);

  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn(
      { requestId: requestContext.requestId, path: req.path },
      'Request missing Bearer authorization header'
    );
    res.status(401).json({ error: 'Authorization header is required' });
    return;
  }

  const accessTokenRaw = authHeader.substring(7).trim();
  const idTokenRaw = getHeader(req, 'x-amzn-bedrock-agentcore-runtime-custom-id-token');

  verifyTokens(accessTokenRaw, idTokenRaw)
    .then(({ accessPayload, idPayload, isMachineUser }) => {
      requestContext.accessTokenPayload = accessPayload;
      requestContext.idTokenPayload = idPayload;
      requestContext.isMachineUser = isMachineUser;
      requestContext.clientId = accessPayload.client_id;
      requestContext.scopes = accessPayload.scope?.split(' ').filter((s) => s.length > 0);

      // Regular users: `sub` is the Cognito User Pool UUID and, by
      // convention, our branded `UserId`. Machine users have no user
      // binding at this layer — `authResolverMiddleware` derives the
      // effective `userId` from the request body's `targetUserId`.
      if (!isMachineUser) {
        const sub = accessPayload.sub;
        if (isUserId(sub)) {
          requestContext.userId = sub as UserId;
        } else {
          logger.warn(
            { requestId: requestContext.requestId, sub },
            'Access token sub is not in the expected Cognito User Pool UUID shape'
          );
        }
      }

      // Forward the raw ID token so `scoped-credentials.ts` can call
      // `GetCredentialsForIdentity`. We keep the raw string (not the
      // verified payload) because the Cognito Identity Pool API expects
      // the JWT wire format.
      if (idTokenRaw) {
        requestContext.idToken = idTokenRaw;
      }

      // Session headers — validated with branded guards.
      const rawSessionId = getHeader(req, 'x-amzn-bedrock-agentcore-runtime-session-id');
      const sessionType = getHeader(req, 'x-amzn-bedrock-agentcore-runtime-session-type') as
        | SessionType
        | undefined;

      if (rawSessionId) {
        if (isSessionId(rawSessionId)) {
          requestContext.sessionId = rawSessionId;
        } else {
          logger.warn(
            { requestId: requestContext.requestId, rawSessionId },
            'Invalid sessionId in header, ignoring'
          );
        }
      }
      requestContext.sessionType = sessionType;

      logger.info(
        {
          requestId: requestContext.requestId,
          userId: requestContext.userId,
          isMachineUser: requestContext.isMachineUser,
          clientId: requestContext.clientId,
          hasIdToken: !!idPayload,
          path: req.path,
          method: req.method,
        },
        'Request authenticated'
      );

      runWithContext(requestContext, () => {
        next();
      });
    })
    .catch((err: unknown) => {
      if (err instanceof JwtVerificationError) {
        // `message` is intentionally short and non-revealing — detailed
        // failure reasons are logged in `verifyAccessToken` /
        // `verifyIdToken`.
        res.status(err.status).json({ error: err.message });
        return;
      }
      logger.error(
        { err, requestId: requestContext.requestId },
        'Unexpected error during JWT verification'
      );
      res.status(500).json({ error: 'Internal authentication error' });
    });
}
