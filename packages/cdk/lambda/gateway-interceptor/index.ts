/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';
import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { IDENTITY_ID_PATTERN, verifyRequestTokens } from './token-verifiers';

const identityIdCache = new Map<string, { identityId: string; expiresAt: number }>();
const MAX_CACHE_ENTRIES = 1000;

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

async function resolveIdentityId(idToken: string, expiresAt: number): Promise<string> {
  const cacheKey = createHash('sha256').update(idToken).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  for (const [key, value] of identityIdCache) {
    if (value.expiresAt <= now) identityIdCache.delete(key);
  }
  const cached = identityIdCache.get(cacheKey);
  if (cached) return cached.identityId;

  const userPoolId = process.env.COGNITO_USER_POOL_ID!;
  const region = userPoolId.split('_')[0];
  const response = await getCognitoClient().send(
    new GetIdCommand({
      IdentityPoolId: process.env.IDENTITY_POOL_ID!,
      Logins: { [`cognito-idp.${region}.amazonaws.com/${userPoolId}`]: idToken },
    })
  );
  if (!response.IdentityId || !IDENTITY_ID_PATTERN.test(response.IdentityId)) {
    throw new Error('Cognito did not return a valid identity');
  }
  if (identityIdCache.size >= MAX_CACHE_ENTRIES) {
    identityIdCache.delete(identityIdCache.keys().next().value!);
  }
  identityIdCache.set(cacheKey, { identityId: response.IdentityId, expiresAt });
  return response.IdentityId;
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

  if (mcpMethod === 'tools/call') {
    const accessToken = extractJwtFromHeaders(headers);
    const idToken = extractIdTokenFromHeaders(headers);
    if (!accessToken || !idToken) {
      throw new Error('Access and identity tokens are required');
    }

    const identity = await verifyRequestTokens(accessToken, idToken);
    const identityId =
      identity.kind === 'developer'
        ? identity.identityId
        : await resolveIdentityId(idToken, identity.expiresAt);
    const params = requestBody.params ?? {};
    params.arguments = {
      ...(params.arguments ?? {}),
      _context: {
        userId: identity.userId,
        identityId,
        storagePath: extractStoragePath(headers),
      },
    };
    requestBody.params = params;
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
