/**
 * Auth Middleware Tests
 *
 * Exercises three concerns:
 *   1. `extractJWTFromHeader` — header parser utility.
 *   2. `getCurrentAuth` / `isMachineUserToken` — request summarisation.
 *   3. `authMiddleware` — the full chain that now performs access + id
 *      JWT verification, the `access.sub === id.sub` token-confusion
 *      defence, and identity-pool identityId resolution.
 *
 * `aws-jwt-verify` is mocked to return programmable results for each of
 * the access / id verifiers, so we can assert middleware behaviour
 * without needing a real Cognito user pool.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock config to avoid env var validation failure at import time.
jest.mock('../../config/index.js', () => ({
  config: {
    COGNITO_USER_POOL_ID: 'us-east-1_testpool',
    COGNITO_USER_POOL_CLIENT_ID: 'frontend-client',
    COGNITO_MACHINE_USER_CLIENT_ID: 'machine-client',
    IDENTITY_POOL_ID: 'us-east-1:pool-id',
    AWS_REGION: 'us-east-1',
  },
  isDevelopment: false,
  corsAllowedOrigins: ['*'],
}));

// Programmable mock for aws-jwt-verify. Each test reconfigures the
// `verify` mocks via `accessVerifyMock` / `idVerifyMock` below.
const accessVerifyMock = jest.fn<(token: string) => Promise<unknown>>();
const idVerifyMock = jest.fn<(token: string) => Promise<unknown>>();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: jest.fn((opts: unknown) => {
      const tokenUse = (opts as { tokenUse: 'access' | 'id' }).tokenUse;
      return {
        verify: tokenUse === 'access' ? accessVerifyMock : idVerifyMock,
        hydrate: jest.fn(() => Promise.resolve(undefined as unknown)),
      };
    }),
  },
}));

// Mock identity-resolver to avoid pulling in @moca/core (workspace
// package not available to jest-resolve in the backend test environment).
const resolveIdentityIdMock = jest.fn<(token: string) => Promise<string>>();
jest.mock('../../libs/auth/identity-resolver.js', () => ({
  resolveIdentityId: resolveIdentityIdMock,
}));

import { extractJWTFromHeader } from '../../libs/auth/index.js';
import { authMiddleware, getCurrentAuth, AuthenticatedRequest } from '../auth.js';
import type { CognitoJWTPayload } from '../../types/index.js';

// ─────────────────────────────────────────────────
// extractJWTFromHeader
// ─────────────────────────────────────────────────

describe('extractJWTFromHeader', () => {
  it('extracts token from valid Bearer header', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
    expect(extractJWTFromHeader(`Bearer ${token}`)).toBe(token);
  });

  it('returns null when header has no Bearer prefix', () => {
    expect(extractJWTFromHeader('eyJhbGciOiJSUzI1NiJ9.payload.signature')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJWTFromHeader('')).toBeNull();
  });

  it('returns null for non-Bearer schemes', () => {
    expect(extractJWTFromHeader('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractJWTFromHeader('Token sometoken')).toBeNull();
  });

  it('trims whitespace from extracted token', () => {
    expect(extractJWTFromHeader('Bearer   eyJtoken  ')).toBe('eyJtoken');
  });

  it('handles Bearer with no token (empty after prefix)', () => {
    const result = extractJWTFromHeader('Bearer ');
    expect(result).toBe('');
  });
});

// ─────────────────────────────────────────────────
// getCurrentAuth – isMachineUserToken (private, tested via getCurrentAuth)
// ─────────────────────────────────────────────────

function mockRequest(
  jwt?: CognitoJWTPayload,
  userId?: string,
  requestId?: string
): AuthenticatedRequest {
  return {
    jwt,
    userId,
    requestId,
    get: jest.fn(),
    header: jest.fn(),
  } as unknown as AuthenticatedRequest;
}

describe('getCurrentAuth - isMachineUserToken detection', () => {
  it('identifies machine user: sub === client_id, no cognito:username, token_use=access', () => {
    const req = mockRequest(
      {
        sub: 'machine-client-id',
        client_id: 'machine-client-id',
        token_use: 'access',
        scope: 'agent/invoke',
      },
      undefined,
      'req-001'
    );

    const auth = getCurrentAuth(req);

    expect(auth.isMachineUser).toBe(true);
    expect(auth.clientId).toBe('machine-client-id');
    expect(auth.userId).toBeUndefined();
  });

  it('identifies regular user: has cognito:username', () => {
    const req = mockRequest(
      {
        sub: 'user-uuid-abc',
        'cognito:username': 'user@example.com',
        client_id: 'app-client-id',
        token_use: 'access',
      },
      'user@example.com'
    );

    const auth = getCurrentAuth(req);

    expect(auth.isMachineUser).toBe(false);
    expect(auth.clientId).toBeUndefined();
    expect(auth.userId).toBe('user@example.com');
  });

  it('returns unauthenticated result when payload is undefined', () => {
    const req = mockRequest(undefined, undefined);

    const auth = getCurrentAuth(req);

    expect(auth.authenticated).toBe(false);
    expect(auth.isMachineUser).toBe(false);
    expect(auth.userId).toBeUndefined();
    expect(auth.groups).toEqual([]);
  });
});

// ─────────────────────────────────────────────────
// authMiddleware — end-to-end behaviour
// ─────────────────────────────────────────────────

function buildRequest(headers: Record<string, string | undefined>): AuthenticatedRequest {
  return {
    get: jest.fn((name: string) => headers[name]),
    header: jest.fn((name: string) => headers[name]),
  } as unknown as AuthenticatedRequest;
}

function buildResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as {
    status: jest.Mock;
    json: jest.Mock;
  };
}

const USER_SUB = 'd7a41aa8-8031-70e8-4916-4c302e63588a';
const ID_TOKEN = 'header.idpayload.sig';
const ACCESS_TOKEN = 'header.accesspayload.sig';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authMiddleware', () => {
  it('responds 401 when Authorization header is missing', async () => {
    const req = buildRequest({});
    const res = buildResponse();
    const next = jest.fn();

    authMiddleware(req, res as never, next as never);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MISSING_AUTHORIZATION' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when access-token verification fails', async () => {
    accessVerifyMock.mockRejectedValueOnce(new Error('invalid signature'));

    const req = buildRequest({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    const res = buildResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      res.json.mockImplementation((body: unknown) => {
        expect((body as { code: string }).code).toBe('INVALID_JWT');
        resolve();
        return res;
      });
      authMiddleware(req, res as never, next as never);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('responds 401 when ID token header is missing for a regular user', async () => {
    accessVerifyMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      token_use: 'access',
      'cognito:username': USER_SUB,
    });

    const req = buildRequest({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    const res = buildResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      res.json.mockImplementation((body: unknown) => {
        expect((body as { code: string }).code).toBe('MISSING_ID_TOKEN');
        resolve();
        return res;
      });
      authMiddleware(req, res as never, next as never);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('responds 401 when ID-token verification fails', async () => {
    accessVerifyMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      token_use: 'access',
      'cognito:username': USER_SUB,
    });
    idVerifyMock.mockRejectedValueOnce(new Error('aud mismatch'));

    const req = buildRequest({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': ID_TOKEN,
    });
    const res = buildResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      res.json.mockImplementation((body: unknown) => {
        expect((body as { code: string }).code).toBe('INVALID_ID_TOKEN');
        resolve();
        return res;
      });
      authMiddleware(req, res as never, next as never);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects with 401 on token-confusion (access.sub !== id.sub)', async () => {
    accessVerifyMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      token_use: 'access',
      'cognito:username': USER_SUB,
    });
    idVerifyMock.mockResolvedValueOnce({
      sub: 'different-user-sub',
      aud: 'frontend-client',
      token_use: 'id',
    });

    const req = buildRequest({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': ID_TOKEN,
    });
    const res = buildResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      res.json.mockImplementation((body: unknown) => {
        expect((body as { code: string }).code).toBe('TOKEN_SUBJECT_MISMATCH');
        resolve();
        return res;
      });
      authMiddleware(req, res as never, next as never);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(resolveIdentityIdMock).not.toHaveBeenCalled();
  });

  it('passes through and populates req when access+id match and identityId resolves', async () => {
    accessVerifyMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      token_use: 'access',
      'cognito:username': USER_SUB,
    });
    idVerifyMock.mockResolvedValueOnce({
      sub: USER_SUB,
      aud: 'frontend-client',
      token_use: 'id',
    });
    resolveIdentityIdMock.mockResolvedValueOnce('us-east-1:identity-uuid');

    const req = buildRequest({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': ID_TOKEN,
    });
    const res = buildResponse();

    await new Promise<void>((resolve) => {
      const next = jest.fn(() => {
        expect(req.userId).toBe(USER_SUB);
        expect(req.idPayload?.sub).toBe(USER_SUB);
        expect(req.identityId).toBe('us-east-1:identity-uuid');
        resolve();
      });
      authMiddleware(req, res as never, next as never);
    });

    expect(res.status).not.toHaveBeenCalled();
  });

  it('skips User-Pool ID verification for developer-auth openIdTokens', async () => {
    // Developer-auth token: iss=cognito-identity.amazonaws.com
    const developerAuthPayload = {
      iss: 'https://cognito-identity.amazonaws.com',
      sub: 'us-east-1:identity-uuid',
    };
    const developerAuthToken = `header.${Buffer.from(JSON.stringify(developerAuthPayload)).toString('base64')}.sig`;

    accessVerifyMock.mockResolvedValueOnce({
      sub: 'machine-client',
      client_id: 'machine-client',
      token_use: 'access',
      scope: 'agent/invoke',
    });
    resolveIdentityIdMock.mockResolvedValueOnce('us-east-1:identity-uuid');

    const req = buildRequest({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': developerAuthToken,
    });
    const res = buildResponse();

    await new Promise<void>((resolve) => {
      const next = jest.fn(() => {
        expect(idVerifyMock).not.toHaveBeenCalled();
        expect(req.identityId).toBe('us-east-1:identity-uuid');
        // idPayload is undefined because User-Pool id-verifier was skipped
        expect(req.idPayload).toBeUndefined();
        resolve();
      });
      authMiddleware(req, res as never, next as never);
    });
  });
});
