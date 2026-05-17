/**
 * Tests for requestContextMiddleware.
 *
 * This middleware is the single choke-point where JWTs are verified and
 * where the token-confusion defence is enforced, so the test matrix is
 * focused on those three responsibilities:
 *
 *  1. Happy path — regular user with matching access + id tokens → next()
 *  2. Token-confusion — access.sub !== id.sub → 401
 *  3. Missing id token for a regular user → 401
 *  4. Machine user (no id token required) → next()
 *  5. Access-token verification failure → 401
 *  6. Missing Authorization header → 401
 *
 * The underlying verifiers are mocked; we trust
 * `libs/auth/__tests__/jwt-verifier.test.ts` to cover their semantics.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const verifyAccessTokenMock = jest.fn<(token: string) => Promise<unknown>>();
const verifyIdTokenMock = jest.fn<(token: string) => Promise<unknown>>();

jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));

jest.unstable_mockModule('../../auth/jwt-verifier.js', () => {
  class JwtVerificationError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
      this.name = 'JwtVerificationError';
    }
  }

  return {
    JwtVerificationError,
    verifyAccessToken: verifyAccessTokenMock,
    verifyIdToken: verifyIdTokenMock,
    classifyAccessToken: (payload: { sub?: string; client_id?: string; username?: string }) => ({
      isMachineUser: !payload.username && (!payload.sub || payload.sub === payload.client_id),
    }),
  };
});

const { requestContextMiddleware } = await import('../request-context.js');
const { getCurrentContext } = await import('../../context/request-context.js');

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/invocations',
    method: 'POST',
    ...overrides,
  } as Request;
}

function createResponse() {
  // `Response` carries a large surface area; we only touch the two
  // methods the middleware calls (`status`, `json`), so a narrow stub
  // keeps the test focused on behaviour rather than typing gymnastics.
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requestContextMiddleware', () => {
  const USER_SUB = 'd7a41aa8-8031-70e8-4916-4c302e63588a';

  it('responds 401 when Authorization header is missing', async () => {
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn() as unknown as NextFunction;

    requestContextMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authorization header is required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when access token verification fails', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(
      Object.assign(new Error('Access token verification failed'), {
        status: 401,
        name: 'JwtVerificationError',
      })
    );

    const req = createRequest({
      headers: { authorization: 'Bearer bad-token' },
    });
    const res = createResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      (res.status as unknown as jest.Mock).mockImplementation(() => {
        resolve();
        return res;
      });
      requestContextMiddleware(req, res, next as unknown as NextFunction);
    });

    expect(next).not.toHaveBeenCalled();
  });

  it('responds 401 when regular user omits the ID token', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      token_use: 'access',
      exp: 1,
      iss: 'x',
      username: USER_SUB,
      raw: { 'cognito:username': USER_SUB },
    });

    const req = createRequest({
      headers: { authorization: 'Bearer at' },
    });
    const res = createResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      (res.json as unknown as jest.Mock).mockImplementation((body: unknown) => {
        expect((body as { error: string }).error).toContain('ID token is required');
        resolve();
        return res;
      });
      requestContextMiddleware(req, res, next as unknown as NextFunction);
    });

    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 on token-confusion (access.sub !== id.sub)', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      token_use: 'access',
      exp: 1,
      iss: 'x',
      username: USER_SUB,
      raw: { 'cognito:username': USER_SUB },
    });
    verifyIdTokenMock.mockResolvedValueOnce({
      sub: 'different-user-sub',
      aud: 'frontend-client',
      token_use: 'id',
      exp: 1,
      iss: 'x',
      raw: {},
    });

    const req = createRequest({
      headers: {
        authorization: 'Bearer at',
        'x-amzn-bedrock-agentcore-runtime-custom-id-token': 'id-token',
      },
    });
    const res = createResponse();
    const next = jest.fn();

    await new Promise<void>((resolve) => {
      (res.json as unknown as jest.Mock).mockImplementation((body: unknown) => {
        expect((body as { error: string }).error).toContain('subjects do not match');
        resolve();
        return res;
      });
      requestContextMiddleware(req, res, next as unknown as NextFunction);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('passes through and populates context for a matching access / id pair', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce({
      sub: USER_SUB,
      client_id: 'frontend-client',
      scope: 'aws.cognito.signin.user.admin',
      token_use: 'access',
      exp: 1,
      iss: 'x',
      username: USER_SUB,
      raw: { 'cognito:username': USER_SUB },
    });
    verifyIdTokenMock.mockResolvedValueOnce({
      sub: USER_SUB,
      aud: 'frontend-client',
      token_use: 'id',
      exp: 1,
      iss: 'x',
      raw: {},
    });

    const req = createRequest({
      headers: {
        authorization: 'Bearer at',
        'x-amzn-bedrock-agentcore-runtime-custom-id-token': 'id-token',
      },
    });
    const res = createResponse();

    await new Promise<void>((resolve) => {
      const next = jest.fn(() => {
        const ctx = getCurrentContext();
        expect(ctx?.userId).toBe(USER_SUB);
        expect(ctx?.isMachineUser).toBe(false);
        expect(ctx?.clientId).toBe('frontend-client');
        expect(ctx?.idToken).toBe('id-token');
        expect(ctx?.accessTokenPayload?.sub).toBe(USER_SUB);
        expect(ctx?.idTokenPayload?.sub).toBe(USER_SUB);
        resolve();
      });
      requestContextMiddleware(req, res, next as unknown as NextFunction);
    });

    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts machine-user access token without requiring an id token', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce({
      sub: 'machine-client',
      client_id: 'machine-client',
      scope: 'agent/invoke',
      token_use: 'access',
      exp: 1,
      iss: 'x',
      raw: {},
    });

    const req = createRequest({
      headers: { authorization: 'Bearer at' },
    });
    const res = createResponse();

    await new Promise<void>((resolve) => {
      const next = jest.fn(() => {
        const ctx = getCurrentContext();
        expect(ctx?.isMachineUser).toBe(true);
        expect(ctx?.clientId).toBe('machine-client');
        expect(ctx?.scopes).toEqual(['agent/invoke']);
        resolve();
      });
      requestContextMiddleware(req, res, next as unknown as NextFunction);
    });

    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });
});
