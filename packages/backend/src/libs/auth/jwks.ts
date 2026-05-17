/**
 * JWT verification for Cognito User Pool tokens (backend side).
 *
 * Two separate verifiers are required because the backend accepts both:
 *   - Access tokens in the `Authorization: Bearer ...` header
 *     (from Frontend Code Flow or Machine User Client Credentials Flow)
 *   - ID tokens in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`
 *     (from the Frontend only; machine users never issue an ID token)
 *
 * Why split?
 * ----------
 * The previous single-verifier approach used `tokenUse: null` and
 * `clientId: clientId ?? null`. That meant:
 *   (a) an ID token could pass validation on the `Authorization` header,
 *       and
 *   (b) when `COGNITO_CLIENT_ID` was absent, ANY App Client on the same
 *       user pool was accepted.
 * Both are the same class of weakness as the agent-side H1 finding
 * (token-confusion / audience bypass). Splitting the verifiers and
 * requiring an explicit `clientId` allow-list closes both.
 *
 * @see https://github.com/awslabs/aws-jwt-verify
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoAccessTokenPayload, CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';

import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
import type { CognitoJWTPayload, JWTVerificationResult } from '../../types/index.js';

let accessTokenVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let idTokenVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

/**
 * Returns the access-token verifier. Accepts both the frontend App Client
 * and (when configured) the machine-user App Client, because both are
 * legitimate issuers of access tokens for this backend.
 */
function getAccessTokenVerifier() {
  if (accessTokenVerifier) return accessTokenVerifier;

  const clientIds: string[] = [config.COGNITO_USER_POOL_CLIENT_ID];
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

/**
 * Returns the ID-token verifier. Only the frontend App Client may issue ID
 * tokens; machine-user Client Credentials flows never produce one.
 */
function getIdTokenVerifier() {
  if (idTokenVerifier) return idTokenVerifier;

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
 * Pre-load the JWKS cache so the first protected request does not pay the
 * Cognito round-trip. Failures are logged but non-fatal — subsequent
 * `verifyJWT` / `verifyIdToken` calls will retry lazily.
 */
export async function hydrateJWKS(): Promise<void> {
  try {
    await Promise.all([getAccessTokenVerifier().hydrate(), getIdTokenVerifier().hydrate()]);
    logger.info('JWKS cache pre-loaded for access and id token verifiers');
  } catch (error) {
    logger.warn({ err: error }, 'Failed to pre-load JWKS cache:');
  }
}

/**
 * Verify a Cognito User Pool access token. Returns `{valid:false}` on any
 * failure mode (malformed / expired / signature mismatch / wrong audience)
 * so callers can respond with 401 without leaking library-specific errors.
 */
export async function verifyJWT(token: string): Promise<JWTVerificationResult> {
  try {
    const payload = (await getAccessTokenVerifier().verify(token)) as CognitoAccessTokenPayload;
    return {
      valid: true,
      payload: payload as unknown as CognitoJWTPayload,
    };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Access token verification failed:'
    );
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'JWT verification failed',
      details: error,
    };
  }
}

/**
 * Verify a Cognito User Pool ID token. Mirrors `verifyJWT` but uses the
 * ID-token verifier (enforces `aud === COGNITO_USER_POOL_CLIENT_ID`).
 *
 * Note: This only covers User Pool ID tokens. Developer-authenticated
 * OpenID tokens issued by `GetOpenIdTokenForDeveloperIdentity` (Trigger
 * Lambda path) CANNOT be verified here — their issuer is
 * `https://cognito-identity.amazonaws.com`, not the User Pool. The
 * caller (`authMiddleware`) is responsible for detecting that token type
 * and skipping this function accordingly; the validation of those tokens
 * is performed by Cognito Identity Pool when `GetCredentialsForIdentity`
 * (or `GetId`) is called downstream.
 */
export async function verifyIdToken(token: string): Promise<JWTVerificationResult> {
  try {
    const payload = (await getIdTokenVerifier().verify(token)) as CognitoIdTokenPayload;
    return {
      valid: true,
      payload: payload as unknown as CognitoJWTPayload,
    };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'ID token verification failed:'
    );
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'ID token verification failed',
      details: error,
    };
  }
}

/**
 * Extract JWT token from Authorization header
 * @param authHeader Authorization header
 * @returns JWT token (without Bearer prefix)
 */
export function extractJWTFromHeader(authHeader: string): string | null {
  if (!authHeader) {
    return null;
  }

  // Check for "Bearer " prefix
  const bearerPrefix = 'Bearer ';
  if (!authHeader.startsWith(bearerPrefix)) {
    logger.warn('Authorization header is not in Bearer format');
    return null;
  }

  // Extract JWT token part
  return authHeader.substring(bearerPrefix.length).trim();
}

/**
 * Reset cached verifier instances. Exposed for tests that need to
 * re-initialise the module with a fresh config fixture.
 */
export function __resetJwtVerifiersForTests(): void {
  accessTokenVerifier = null;
  idTokenVerifier = null;
}
