/**
 * Tests for the Cognito JWT verifier wrapper.
 *
 * The goal is to prove the wrapper surface-level contract:
 *  - Successful verification returns a narrow typed payload
 *  - Any `aws-jwt-verify` failure surfaces as `JwtVerificationError`
 *    with status 401 (not leaking library-specific error types upward)
 *  - Access tokens and ID tokens are verified with different
 *    `tokenUse` / `clientId` configurations
 *  - Machine user classification is purely structural
 *
 * `aws-jwt-verify` itself is trusted to implement JWKS / signature
 * checks correctly, so we mock it entirely.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const verifyAccessMock = jest.fn<(token: string) => Promise<unknown>>();
const verifyIdMock = jest.fn<(token: string) => Promise<unknown>>();
const hydrateAccessMock = jest.fn<() => Promise<void>>();
const hydrateIdMock = jest.fn<() => Promise<void>>();

type CreateOpts = { tokenUse: 'access' | 'id'; clientId: string | string[] };
type VerifierStub = {
  verify: (token: string) => Promise<unknown>;
  hydrate: () => Promise<void>;
};
const verifierCreateMock = jest.fn<(opts: CreateOpts) => VerifierStub>();

jest.unstable_mockModule('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: verifierCreateMock,
  },
}));

jest.unstable_mockModule('../../../config/index.js', () => ({
  config: {
    COGNITO_USER_POOL_ID: 'us-east-1_test',
    COGNITO_USER_POOL_CLIENT_ID: 'frontend-client',
    COGNITO_MACHINE_USER_CLIENT_ID: 'machine-client',
    AWS_REGION: 'us-east-1',
  },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  JwtVerificationError,
  classifyAccessToken,
  hydrateJwtVerifiers,
  resetJwtVerifiersForTesting,
  verifyAccessToken,
  verifyIdToken,
} = await import('../jwt-verifier.js');

beforeEach(() => {
  jest.clearAllMocks();
  resetJwtVerifiersForTesting();

  // `CognitoJwtVerifier.create` is called twice (access + id). We
  // differentiate by inspecting the `tokenUse` argument the module
  // passed in, and hand back distinct fake verifier instances.
  verifierCreateMock.mockImplementation(
    (opts: { tokenUse: 'access' | 'id'; clientId: string | string[] }) => {
      if (opts.tokenUse === 'access') {
        return { verify: verifyAccessMock, hydrate: hydrateAccessMock };
      }
      return { verify: verifyIdMock, hydrate: hydrateIdMock };
    }
  );
});

describe('verifyAccessToken', () => {
  it('returns a narrowed payload on successful verification', async () => {
    verifyAccessMock.mockResolvedValueOnce({
      sub: 'user-uuid',
      client_id: 'frontend-client',
      scope: 'aws.cognito.signin.user.admin',
      token_use: 'access',
      exp: 1_700_000_000,
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
      username: 'user@example.com',
    });

    const payload = await verifyAccessToken('header.payload.sig');

    expect(payload.sub).toBe('user-uuid');
    expect(payload.client_id).toBe('frontend-client');
    expect(payload.token_use).toBe('access');
    expect(payload.username).toBe('user@example.com');
  });

  it('creates the verifier with both frontend and machine user client ids', async () => {
    verifyAccessMock.mockResolvedValueOnce({
      sub: 'machine-client',
      client_id: 'machine-client',
      token_use: 'access',
      exp: 1,
      iss: 'x',
    });

    await verifyAccessToken('header.payload.sig');

    // The first `create` call is for the access-token verifier.
    const firstCall = verifierCreateMock.mock.calls[0][0] as {
      tokenUse: string;
      clientId: string[];
    };
    expect(firstCall.tokenUse).toBe('access');
    expect(firstCall.clientId).toEqual(['frontend-client', 'machine-client']);
  });

  it('throws JwtVerificationError with 401 on any verify failure', async () => {
    verifyAccessMock.mockRejectedValueOnce(new Error('invalid signature'));

    await expect(verifyAccessToken('header.payload.sig')).rejects.toBeInstanceOf(
      JwtVerificationError
    );
    await expect(verifyAccessToken('header.payload.sig')).rejects.toMatchObject({ status: 401 });
  });
});

describe('verifyIdToken', () => {
  it('creates the ID verifier with only the frontend client id', async () => {
    verifyIdMock.mockResolvedValueOnce({
      sub: 'user-uuid',
      aud: 'frontend-client',
      token_use: 'id',
      exp: 1,
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    });

    await verifyIdToken('header.payload.sig');

    // First call is the access verifier (constructed lazily on the ID
    // side because `create` is called when either verifier is first
    // needed) — we iterate to find the `tokenUse: 'id'` call.
    const idCreateCall = verifierCreateMock.mock.calls.find(
      ([opts]) => (opts as { tokenUse: string }).tokenUse === 'id'
    )?.[0] as { tokenUse: string; clientId: string };
    expect(idCreateCall.clientId).toBe('frontend-client');
  });

  it('throws JwtVerificationError on failure', async () => {
    verifyIdMock.mockRejectedValueOnce(new Error('aud mismatch'));

    await expect(verifyIdToken('header.payload.sig')).rejects.toBeInstanceOf(JwtVerificationError);
  });
});

describe('classifyAccessToken', () => {
  it('classifies tokens with cognito:username as regular users', () => {
    expect(
      classifyAccessToken({
        sub: 'user-uuid',
        client_id: 'frontend-client',
        token_use: 'access',
        exp: 1,
        iss: 'x',
        username: 'user@example.com',
        raw: { 'cognito:username': 'user@example.com' },
      })
    ).toEqual({ isMachineUser: false });
  });

  it('classifies tokens where sub equals client_id as machine users', () => {
    expect(
      classifyAccessToken({
        sub: 'machine-client',
        client_id: 'machine-client',
        token_use: 'access',
        exp: 1,
        iss: 'x',
        raw: {},
      })
    ).toEqual({ isMachineUser: true });
  });

  it('classifies tokens where sub differs from client_id as regular users', () => {
    expect(
      classifyAccessToken({
        sub: 'user-uuid',
        client_id: 'frontend-client',
        token_use: 'access',
        exp: 1,
        iss: 'x',
        raw: {},
      })
    ).toEqual({ isMachineUser: false });
  });
});

describe('hydrateJwtVerifiers', () => {
  it('warms both access and id JWKS caches', async () => {
    hydrateAccessMock.mockResolvedValueOnce(undefined);
    hydrateIdMock.mockResolvedValueOnce(undefined);

    await hydrateJwtVerifiers();

    expect(hydrateAccessMock).toHaveBeenCalledTimes(1);
    expect(hydrateIdMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when hydrate fails (logs and continues)', async () => {
    hydrateAccessMock.mockRejectedValueOnce(new Error('network'));
    hydrateIdMock.mockResolvedValueOnce(undefined);

    await expect(hydrateJwtVerifiers()).resolves.toBeUndefined();
  });
});
