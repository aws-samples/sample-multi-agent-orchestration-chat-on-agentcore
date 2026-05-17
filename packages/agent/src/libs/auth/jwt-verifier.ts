/**
 * JWT verification for Cognito User Pool tokens.
 *
 * AgentCore Runtime already performs authorizer-level JWT validation, but
 * that signal alone is insufficient for two reasons:
 *
 *  1. ID tokens are forwarded via a custom header
 *     (`X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`) and are NOT
 *     validated by the authorizer. Without a second verification step
 *     an attacker can pair user B's access token with user A's ID token
 *     (token-confusion attack) and cause the runtime to mint user A's
 *     Identity Pool credentials while request-context thinks it is B.
 *  2. We need the parsed `sub` from both tokens to assert they match.
 *     Any code path that reads `sub` from an unverified JWT payload is
 *     inherently trust-on-first-use.
 *
 * This module wraps `aws-jwt-verify` to provide:
 *  - Signature verification against Cognito JWKS (network-cached)
 *  - `iss` / `aud` / `exp` / `token_use` enforcement
 *  - A narrow, typed payload surface that downstream code can rely on
 *
 * @see https://github.com/awslabs/aws-jwt-verify
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoAccessTokenPayload, CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';

import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';

/**
 * Verified access token payload. Narrowed to the claims the runtime
 * actually reads so that adding new business logic is forced through a
 * conscious type update rather than silently depending on untyped keys.
 */
export interface VerifiedAccessTokenPayload {
  sub: string;
  client_id: string;
  scope?: string;
  token_use: 'access';
  exp: number;
  iss: string;
  /** `cognito:username` is only present on user access tokens. */
  username?: string;
  /**
   * Raw payload for diagnostic logging. Intentionally typed as
   * `Record<string, unknown>` so that callers cannot read un-narrowed
   * claims without acknowledging the loss of type safety.
   */
  raw: Record<string, unknown>;
}

/**
 * Verified ID token payload.
 */
export interface VerifiedIdTokenPayload {
  sub: string;
  aud: string;
  token_use: 'id';
  exp: number;
  iss: string;
  'cognito:username'?: string;
  email?: string;
  raw: Record<string, unknown>;
}

/**
 * Error raised when JWT verification fails. Carries an HTTP status so
 * the Express error handler can surface an appropriate 4xx.
 */
export class JwtVerificationError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'JwtVerificationError';
  }
}

/**
 * Access token verifier — lazily initialised on first use. A single
 * verifier accepts both the frontend client and (when configured) the
 * machine-user client, because `aws-jwt-verify` will check that the
 * token's `client_id` claim matches one of the supplied values.
 */
let accessTokenVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

/**
 * ID token verifier — lazily initialised on first use. Only the
 * frontend client is ever valid as an `aud` because machine-user flows
 * never produce ID tokens.
 */
let idTokenVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getAccessTokenVerifier() {
  if (accessTokenVerifier) {
    return accessTokenVerifier;
  }

  const clientIds = [config.COGNITO_USER_POOL_CLIENT_ID];
  if (config.COGNITO_MACHINE_USER_CLIENT_ID) {
    clientIds.push(config.COGNITO_MACHINE_USER_CLIENT_ID);
  }

  logger.info(
    {
      userPoolId: config.COGNITO_USER_POOL_ID,
      allowedClientIds: clientIds,
    },
    'Initialising Cognito access token verifier'
  );

  accessTokenVerifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    tokenUse: 'access',
    clientId: clientIds,
  });
  return accessTokenVerifier;
}

function getIdTokenVerifier() {
  if (idTokenVerifier) {
    return idTokenVerifier;
  }

  logger.info(
    {
      userPoolId: config.COGNITO_USER_POOL_ID,
      clientId: config.COGNITO_USER_POOL_CLIENT_ID,
    },
    'Initialising Cognito ID token verifier'
  );

  idTokenVerifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    tokenUse: 'id',
    clientId: config.COGNITO_USER_POOL_CLIENT_ID,
  });
  return idTokenVerifier;
}

/**
 * Pre-warm the JWKS cache so the first real request does not pay the
 * network round-trip. Called from `src/index.ts` during server startup.
 * Failures are logged but non-fatal — the first verification call will
 * retry.
 */
export async function hydrateJwtVerifiers(): Promise<void> {
  try {
    await Promise.all([getAccessTokenVerifier().hydrate(), getIdTokenVerifier().hydrate()]);
    logger.info('JWT verifier JWKS cache pre-loaded');
  } catch (err) {
    logger.warn({ err }, 'Failed to pre-load JWKS cache — continuing with lazy fetch');
  }
}

/**
 * Reset cached verifier instances. Exposed for tests that need to
 * re-initialise the module with a new config fixture.
 */
export function resetJwtVerifiersForTesting(): void {
  accessTokenVerifier = null;
  idTokenVerifier = null;
}

/**
 * Verify a Cognito access token. Resolves with a narrowed payload or
 * throws `JwtVerificationError` on any failure (signature / claims /
 * expiry / client_id mismatch).
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccessTokenPayload> {
  try {
    const payload = (await getAccessTokenVerifier().verify(token)) as CognitoAccessTokenPayload;
    return {
      sub: payload.sub,
      client_id: payload.client_id,
      scope: typeof payload.scope === 'string' ? payload.scope : undefined,
      token_use: 'access',
      exp: payload.exp,
      iss: payload.iss,
      username: typeof payload.username === 'string' ? payload.username : undefined,
      raw: payload as unknown as Record<string, unknown>,
    };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : 'unknown',
      },
      'Access token verification failed'
    );
    throw new JwtVerificationError(401, 'Access token verification failed', err);
  }
}

/**
 * Verify a Cognito ID token. Resolves with a narrowed payload or throws
 * `JwtVerificationError` on any failure.
 *
 * The verifier enforces `aud === COGNITO_USER_POOL_CLIENT_ID`, so an ID
 * token minted for a different App Client is rejected even if the user
 * pool is shared.
 */
export async function verifyIdToken(token: string): Promise<VerifiedIdTokenPayload> {
  try {
    const payload = (await getIdTokenVerifier().verify(token)) as CognitoIdTokenPayload;
    return {
      sub: payload.sub,
      aud: payload.aud,
      token_use: 'id',
      exp: payload.exp,
      iss: payload.iss,
      'cognito:username':
        typeof payload['cognito:username'] === 'string' ? payload['cognito:username'] : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      raw: payload as unknown as Record<string, unknown>,
    };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : 'unknown',
      },
      'ID token verification failed'
    );
    throw new JwtVerificationError(401, 'ID token verification failed', err);
  }
}

/**
 * Classify a verified access token as machine-user vs regular-user.
 *
 * This runs AFTER signature + clientId verification so it can trust the
 * payload fields. The classification is purely structural:
 *
 *  - Machine user (Client Credentials Flow):
 *      - `token_use` === 'access'
 *      - no `cognito:username` / `username` claim (only machines skip it)
 *      - `sub` is missing or equals `client_id`
 *
 *  - Regular user (Authorization Code Flow):
 *      - `token_use` === 'access'
 *      - has a user identifier claim, or
 *      - `sub` differs from `client_id`
 */
export function classifyAccessToken(payload: VerifiedAccessTokenPayload): {
  isMachineUser: boolean;
} {
  const username = payload.username ?? payload.raw['cognito:username'];
  const hasUserIdentifier = typeof username === 'string' && username.length > 0;
  const subEqualsClientId = !payload.sub || payload.sub === payload.client_id;
  return {
    isMachineUser: !hasUserIdentifier && subEqualsClientId,
  };
}
