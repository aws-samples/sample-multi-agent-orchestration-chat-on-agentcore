/**
 * AgentCore Gateway Request Interceptor
 *
 * Intercepts tools/call requests and injects user context (_context) into
 * the request body arguments. The Gateway's CUSTOM_JWT authorizer has already
 * validated the token, so we only decode the payload (no signature verification).
 *
 * Context injection format:
 *   arguments._context = {
 *     "userId": "<sub claim>",        // Cognito User Pool sub (UUID)
 *     "identityId": "<REGION:uuid>",  // Cognito Identity Pool identityId
 *     "storagePath": "/"
 *   }
 *
 * identityId is resolved via Cognito Identity Pool GetId using the ID Token.
 * It is cached in Lambda module scope (warm instance reuse) to minimise GetId API calls.
 * identityId is stable for the lifetime of the Identity Pool, so TTL-less caching is safe.
 *
 * Other MCP methods (tools/list, etc.) are passed through unchanged.
 * Existing Lambda tools that do not use _context are unaffected.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';

// Module-scope cache: userId → identityId (stable for Identity Pool lifetime)
const identityIdCache = new Map<string, string>();

// Lazily-initialised Cognito Identity client (reused across warm invocations)
let cognitoClient: CognitoIdentityClient | undefined;
function getCognitoClient(): CognitoIdentityClient {
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityClient({ region: process.env.AWS_REGION });
  }
  return cognitoClient;
}

interface InterceptorEvent {
  mcp?: {
    gatewayRequest?: {
      headers?: Record<string, string>;
      body?: any;
    };
    gatewayResponse?: {
      body?: any;
      statusCode?: number;
    };
  };
}

interface InterceptorResponse {
  interceptorOutputVersion: '1.0';
  mcp: {
    transformedGatewayRequest?: {
      headers?: Record<string, string>;
      body?: any;
    };
    transformedGatewayResponse?: {
      body?: any;
      statusCode?: number;
    };
  };
}

interface JwtPayload {
  sub?: string;
  client_id?: string;
  'cognito:username'?: string;
  username?: string;
  [key: string]: unknown;
}

/**
 * Decode JWT payload without signature verification.
 * The Gateway has already validated the signature so we only need the claims.
 */
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    // Add base64url padding
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Extract the `sub` claim from JWT for use as user identifier.
 *
 * The `sub` claim (UUID) is used because:
 * - It is guaranteed to be unique and immutable in Cognito
 * - It is safe for S3 key paths (no special characters)
 * - `cognito:username` may be an email address with characters
 *   that complicate S3 paths
 *
 * For machine users (Client Credentials Flow), `sub` equals `client_id`
 * and there is no human user — we still return it for consistency.
 */
function extractUserId(jwtPayload: JwtPayload): string | null {
  const sub = jwtPayload.sub;
  if (sub) return sub;
  return null;
}

/**
 * Extract storage path from x-storage-path header (case-insensitive).
 * Falls back to '/' if the header is missing or empty.
 */
function extractStoragePath(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-storage-path' && value) {
      return value;
    }
  }
  return '/';
}

/**
 * Extract raw JWT token from Authorization header (case-insensitive).
 */
function extractJwtFromHeaders(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
      return value.slice(7);
    }
  }
  return null;
}

/**
 * Extract the Cognito ID Token from the custom forwarded header.
 *
 * The frontend sends the ID Token via X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token
 * (the same header used for AgentCore Runtime). This is an ID Token (not an Access Token),
 * which is required by Cognito Identity Pool GetId — Access Tokens lack the `aud` claim.
 */
function extractIdTokenFromHeaders(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-amzn-bedrock-agentcore-runtime-custom-id-token' && value) {
      return value;
    }
  }
  return null;
}

/**
 * Cognito Identity Pool identityId shape: "<region>:<uuid>" (case-insensitive).
 *
 * Duplicated here instead of importing from `@moca/core` so this Lambda stays
 * free of workspace-package runtime deps — CDK bundles this file standalone.
 */
const IDENTITY_ID_PATTERN =
  /^[a-z]{2}-(?:(?:gov-)?[a-z]+-\d):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Developer-authenticated OpenID tokens issued by
 * `GetOpenIdTokenForDeveloperIdentity` carry this issuer. They cannot be
 * verified against the User Pool JWKS and `GetId` refuses them with
 * `NotAuthorizedException: Invalid login token`. Instead, `sub` encodes the
 * identityId directly — see agent / backend for the equivalent branching.
 */
const DEVELOPER_AUTH_ISSUER = 'cognito-identity.amazonaws.com';

/**
 * Decode JWT payload without verifying the signature. We only read `iss`
 * and `sub` here to branch on token type. Final authorisation is enforced
 * downstream by Cognito (`GetCredentialsForIdentity` validates the token
 * against the Identity Pool before any credential is minted), so running
 * an extra local verifier here would add cost without closing the
 * security boundary.
 */
function decodeJwtClaims(token: string): { iss?: string; sub?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the Cognito Identity Pool identityId for a given user.
 *
 * Two supported token types:
 *   1. User Pool ID Token (frontend-originated requests):
 *      - iss: `https://cognito-idp.{region}.amazonaws.com/{poolId}`
 *      - Flow: call `GetId` to resolve identityId.
 *   2. Developer-authenticated OpenID Token (Trigger Lambda relay):
 *      - iss: `https://cognito-identity.amazonaws.com`
 *      - sub: the identityId itself (`REGION:UUID`).
 *      - Flow: use `sub` directly. `GetId` rejects this token type with
 *        `NotAuthorizedException: Invalid login token`.
 *
 * Uses a module-scope in-memory cache keyed by userId. identityId is
 * stable for the Identity Pool lifetime, so no TTL is required. Warm
 * Lambda instances hit the cache on subsequent invocations.
 *
 * @param userId - Cognito User Pool sub (UUID) for frontend requests, or
 *                 the same identifier Trigger Lambda forwards via
 *                 `_context.userId` for event-driven requests.
 * @param idToken - UserPool ID Token or developer-auth OpenID Token.
 * @returns identityId in "REGION:uuid" format, or null on failure.
 */
async function resolveIdentityId(userId: string, idToken: string): Promise<string | null> {
  const identityPoolId = process.env.IDENTITY_POOL_ID;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const region = process.env.AWS_REGION || 'us-east-1';

  if (!identityPoolId || !userPoolId) {
    console.warn(
      'IDENTITY_POOL_ID or COGNITO_USER_POOL_ID not configured — skipping identityId resolution'
    );
    return null;
  }

  // Return from cache if available (warm instance reuse)
  const cached = identityIdCache.get(userId);
  if (cached) {
    return cached;
  }

  // Branch on token type BEFORE calling `GetId`. Developer-auth tokens
  // must never reach `GetId` because Cognito will throw
  // `NotAuthorizedException: Invalid login token. Can't pass in a Cognito token.`
  const claims = decodeJwtClaims(idToken);
  const isDeveloperAuthToken =
    typeof claims?.iss === 'string' && claims.iss.includes(DEVELOPER_AUTH_ISSUER);

  if (isDeveloperAuthToken) {
    const identityId = claims?.sub;
    if (!identityId || !IDENTITY_ID_PATTERN.test(identityId)) {
      console.warn(
        `Developer-auth token missing a valid "<region>:<uuid>" sub claim: ${identityId ?? '(none)'}`
      );
      return null;
    }
    identityIdCache.set(userId, identityId);
    console.info(`Resolved identityId for user=${userId} from developer-auth sub: ${identityId}`);
    return identityId;
  }

  try {
    const loginsKey = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    const response = await getCognitoClient().send(
      new GetIdCommand({
        IdentityPoolId: identityPoolId,
        Logins: { [loginsKey]: idToken },
      })
    );

    const identityId = response.IdentityId;
    if (!identityId) {
      console.warn('GetId did not return an IdentityId');
      return null;
    }

    identityIdCache.set(userId, identityId);
    console.info(`Resolved identityId for user=${userId}: ${identityId}`);
    return identityId;
  } catch (err) {
    console.error('Failed to resolve identityId via GetId:', err);
    return null;
  }
}

/**
 * Lambda handler for Gateway REQUEST interceptor.
 *
 * For tools/call: injects _context into arguments.
 * For all other methods: passes through unchanged.
 */
export const handler = async (event: InterceptorEvent): Promise<InterceptorResponse> => {
  const mcpData = event.mcp ?? {};

  // RESPONSE interceptor path (should not be reached, but handle gracefully)
  if (mcpData.gatewayResponse != null) {
    console.info('RESPONSE interceptor pass-through');
    return {
      interceptorOutputVersion: '1.0',
      mcp: {
        transformedGatewayResponse: {
          body: mcpData.gatewayResponse.body ?? {},
          statusCode: mcpData.gatewayResponse.statusCode ?? 200,
        },
      },
    };
  }

  // REQUEST interceptor path
  const gatewayRequest = mcpData.gatewayRequest ?? {};
  const requestBody = gatewayRequest.body ?? {};
  const headers = gatewayRequest.headers ?? {};
  const mcpMethod: string = requestBody.method ?? 'unknown';

  console.info(`REQUEST interceptor: method=${mcpMethod}`);

  // Only inject context for tools/call
  if (mcpMethod === 'tools/call') {
    const jwtToken = extractJwtFromHeaders(headers);
    if (jwtToken) {
      const jwtPayload = decodeJwtPayload(jwtToken);
      if (jwtPayload) {
        const userId = extractUserId(jwtPayload);
        if (userId) {
          const params = requestBody.params ?? {};
          const args = params.arguments ?? {};

          // Resolve identityId using the Cognito ID Token from the custom header.
          // The Authorization header carries an Access Token which lacks the `aud` claim
          // required by Cognito Identity Pool GetId — only ID Tokens are accepted.
          const idToken = extractIdTokenFromHeaders(headers);
          const identityId = idToken ? await resolveIdentityId(userId, idToken) : null;
          if (!idToken) {
            console.warn(
              'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token header not found — identityId will not be injected'
            );
          }

          args._context = {
            userId,
            ...(identityId && { identityId }),
            storagePath: extractStoragePath(headers),
          };
          params.arguments = args;
          requestBody.params = params;
          console.info(
            `Injected _context for user=${userId}${identityId ? `, identityId=${identityId}` : ''}`
          );
        } else {
          console.warn('Could not extract sub claim from JWT');
        }
      } else {
        console.warn('Failed to decode JWT payload');
      }
    } else {
      console.warn('No Authorization header found');
    }
  }

  return {
    interceptorOutputVersion: '1.0',
    mcp: {
      transformedGatewayRequest: {
        body: requestBody,
      },
    },
  };
};
