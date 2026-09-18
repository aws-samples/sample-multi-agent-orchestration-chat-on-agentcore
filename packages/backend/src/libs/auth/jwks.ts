/**
 * JWT verification for the token types the backend accepts.
 *
 * Three separate verifiers are required:
 *   - Access tokens in the `Authorization: Bearer ...` header
 *     (from Frontend Code Flow or Machine User Client Credentials Flow)
 *   - ID tokens in `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`
 *     (from the Frontend only; machine users never issue an ID token)
 *   - Developer-authenticated OpenID tokens in the same header, minted by
 *     `GetOpenIdTokenForDeveloperIdentity` (Trigger Lambda / event-driven
 *     path). Issued by Cognito Identity, NOT the User Pool, so they need
 *     their own issuer + JWKS.
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

import { CognitoJwtVerifier, JwtRsaVerifier } from 'aws-jwt-verify';
import type { CognitoAccessTokenPayload, CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';

import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
import type {
  CognitoJWTPayload,
  DeveloperAuthTokenVerificationResult,
  JWTVerificationResult,
} from '../../types/index.js';

let accessTokenVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let idTokenVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let developerAuthVerifier: ReturnType<typeof JwtRsaVerifier.create> | null = null;

/**
 * Issuer and JWKS endpoint for tokens minted by
 * `GetOpenIdTokenForDeveloperIdentity`. Cognito Identity is an OIDC provider
 * in its own right; the discovery document at
 * `https://cognito-identity.amazonaws.com/.well-known/openid-configuration`
 * advertises this `jwks_uri` and `RS512` as the signing algorithm.
 */
const DEVELOPER_AUTH_ISSUER_URL = 'https://cognito-identity.amazonaws.com';
const DEVELOPER_AUTH_JWKS_URI = 'https://cognito-identity.amazonaws.com/.well-known/jwks_uri';

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
 * Returns the verifier for developer-authenticated OpenID tokens.
 *
 * `audience` is pinned to this deployment's Identity Pool ID because Cognito
 * Identity signs tokens for every pool in the region with the same keys: a
 * valid signature alone only proves "some Cognito pool minted this", not
 * "our pool minted this". The `aud` claim carries the pool ID (it is the
 * source of the `cognito-identity.amazonaws.com:aud` IAM condition key used
 * in web-identity trust policies), so pinning it confines accepted tokens to
 * this deployment.
 */
function getDeveloperAuthVerifier() {
  if (developerAuthVerifier) return developerAuthVerifier;

  logger.info(
    { issuer: DEVELOPER_AUTH_ISSUER_URL, audience: config.IDENTITY_POOL_ID },
    'Initialising developer-auth OpenID token verifier'
  );

  developerAuthVerifier = JwtRsaVerifier.create({
    issuer: DEVELOPER_AUTH_ISSUER_URL,
    audience: config.IDENTITY_POOL_ID,
    jwksUri: DEVELOPER_AUTH_JWKS_URI,
  });
  return developerAuthVerifier;
}

/**
 * Pre-load the JWKS cache so the first protected request does not pay the
 * Cognito round-trip. Failures are logged but non-fatal — subsequent
 * `verifyJWT` / `verifyIdToken` calls will retry lazily.
 */
export async function hydrateJWKS(): Promise<void> {
  try {
    await Promise.all([
      getAccessTokenVerifier().hydrate(),
      getIdTokenVerifier().hydrate(),
      getDeveloperAuthVerifier().hydrate(),
    ]);
    logger.info('JWKS cache pre-loaded for access, id and developer-auth token verifiers');
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
 * `https://cognito-identity.amazonaws.com`, not the User Pool. Those go
 * through `verifyDeveloperAuthOpenIdToken` instead.
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
 * Verify a developer-authenticated OpenID token minted by
 * `GetOpenIdTokenForDeveloperIdentity` and return its verified `sub`, which is
 * the Identity Pool identityId.
 *
 * This MUST be called before the identityId is used for anything, because the
 * identityId is the partition key for every per-user resource (S3 prefix,
 * DynamoDB, AgentCore Memory actor). On the S3 and DynamoDB paths the backend
 * mints credentials via STS AssumeRole with a session policy built from the
 * identityId and never hands the token to Cognito, so there is no downstream
 * AWS-side validation to fall back on: an unverified `sub` here is an
 * attacker-chosen storage key.
 */
export async function verifyDeveloperAuthOpenIdToken(
  token: string
): Promise<DeveloperAuthTokenVerificationResult> {
  try {
    const payload = await getDeveloperAuthVerifier().verify(token);
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      return { valid: false, error: 'Developer-auth OpenID token has no `sub` claim' };
    }
    return { valid: true, identityId: sub };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      'Developer-auth OpenID token verification failed:'
    );
    return {
      valid: false,
      error:
        error instanceof Error ? error.message : 'Developer-auth OpenID token verification failed',
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
  developerAuthVerifier = null;
}
