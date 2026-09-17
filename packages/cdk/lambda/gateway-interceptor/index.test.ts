import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier, JwtVerifier } from 'aws-jwt-verify';
import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';

jest.mock('@aws-sdk/client-cognito-identity', () => ({
  ...jest.requireActual<object>('@aws-sdk/client-cognito-identity'),
  CognitoIdentityClient: jest.fn(),
}));

const poolId = 'us-east-1:00000000-0000-0000-0000-000000000000';
const userPoolId = 'us-east-1_testpool';
const issuer = `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`;
const developerIssuer = 'https://cognito-identity.amazonaws.com';
const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const identityA = 'us-east-1:11111111-1111-1111-1111-111111111111';
const identityB = 'us-east-1:22222222-2222-2222-2222-222222222222';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kty: 'RSA',
  kid: 'test-key',
  use: 'sig',
};
const now = () => Math.floor(Date.now() / 1000);
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let handler: typeof import('./index').handler;

function token(payload: Record<string, unknown>, algorithm = 'RS256', wrongKey = false) {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'test-key' })).toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${header}.${body}`;
  const signature =
    algorithm === 'none'
      ? ''
      : sign(
          algorithm === 'RS512' ? 'RSA-SHA512' : 'RSA-SHA256',
          Buffer.from(input),
          wrongKey ? otherKeys.privateKey : keys.privateKey
        ).toString('base64url');
  return `${input}.${signature}`;
}

function access(overrides: Record<string, unknown> = {}) {
  return token({
    iss: issuer,
    token_use: 'access',
    client_id: 'frontend-client',
    sub: userId,
    username: 'test-user',
    exp: now() + 600,
    ...overrides,
  });
}

function machine(overrides: Record<string, unknown> = {}) {
  return access({
    client_id: 'machine-client',
    sub: 'machine-client',
    username: undefined,
    scope: 'agent/invoke agent/tools',
    ...overrides,
  });
}

function id(overrides: Record<string, unknown> = {}) {
  return token({
    iss: issuer,
    token_use: 'id',
    aud: 'frontend-client',
    sub: userId,
    exp: now() + 600,
    ...overrides,
  });
}

function developer(overrides: Record<string, unknown> = {}, algorithm = 'RS512', wrongKey = false) {
  return token(
    { iss: developerIssuer, aud: poolId, sub: identityA, exp: now() + 600, ...overrides },
    algorithm,
    wrongKey
  );
}

function event(accessToken: string | undefined, idToken: string | undefined) {
  return {
    mcp: {
      gatewayRequest: {
        headers: {
          ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
          ...(idToken === undefined
            ? {}
            : { 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': idToken }),
          'x-storage-path': 'workspace',
        },
        body: {
          method: 'tools/call',
          params: {
            name: 'test-tool',
            arguments: {
              _context: { userId: 'untrusted', identityId: identityB },
            },
          },
        },
      },
    },
  };
}

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.resetModules();
  Object.assign(process.env, {
    IDENTITY_POOL_ID: poolId,
    COGNITO_USER_POOL_ID: userPoolId,
    COGNITO_USER_POOL_CLIENT_ID: 'frontend-client',
    COGNITO_MACHINE_USER_CLIENT_ID: 'machine-client',
    AWS_REGION: 'us-east-1',
  });
  const sdk = await import('@aws-sdk/client-cognito-identity');
  mockSend.mockReset().mockResolvedValue({ IdentityId: identityA });
  jest
    .mocked(sdk.CognitoIdentityClient, { shallow: true })
    .mockImplementation(
      () => ({ send: mockSend }) as unknown as jest.Mocked<CognitoIdentityClient>
    );
  const jwt = await import('aws-jwt-verify');
  const originalCognito = jwt.CognitoJwtVerifier.create;
  const originalGeneric = jwt.JwtVerifier.create;
  jest.spyOn(jwt.CognitoJwtVerifier, 'create').mockImplementation(((
    ...args: Parameters<typeof CognitoJwtVerifier.create>
  ) => {
    const verifier = originalCognito.apply(jwt.CognitoJwtVerifier, args);
    verifier.cacheJwks({ keys: [{ ...jwk, alg: 'RS256' }] }, userPoolId);
    return verifier;
  }) as typeof CognitoJwtVerifier.create);
  jest.spyOn(jwt.JwtVerifier, 'create').mockImplementation(((
    ...args: Parameters<typeof JwtVerifier.create>
  ) => {
    const verifier = originalGeneric.apply(jwt.JwtVerifier, args);
    verifier.cacheJwks({ keys: [{ ...jwk, alg: 'RS512' }] }, developerIssuer);
    return verifier;
  }) as typeof JwtVerifier.create);
  handler = (await import('./index.js')).handler;
});

describe('Gateway identity authentication', () => {
  it('verifies both user tokens and replaces caller-provided context', async () => {
    const result = await handler(event(access(), id()));
    expect(result.mcp.transformedGatewayRequest?.body.params.arguments._context).toEqual({
      userId,
      identityId: identityA,
      storagePath: 'workspace',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as GetIdCommand;
    expect(command.input).toEqual({
      IdentityPoolId: poolId,
      Logins: {
        [`cognito-idp.us-east-1.amazonaws.com/${userPoolId}`]: id(),
      },
    });
  });

  it('accepts a signed delegated identity from the allowed machine client', async () => {
    const result = await handler(event(machine(), developer()));
    expect(result.mcp.transformedGatewayRequest?.body.params.arguments._context.identityId).toBe(
      identityA
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not cache one delegated user under a shared machine client', async () => {
    await handler(event(machine(), developer()));
    const result = await handler(event(machine(), developer({ sub: identityB })));
    expect(result.mcp.transformedGatewayRequest?.body.params.arguments._context.identityId).toBe(
      identityB
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['missing access token', () => event(undefined, id())],
    ['missing ID token', () => event(access(), undefined)],
    ['regular user with signed developer token', () => event(access(), developer())],
    ['machine user with regular ID token', () => event(machine(), id())],
    [
      'wrong machine client',
      () => event(machine({ client_id: 'other-client', sub: 'other-client' }), developer()),
    ],
    ['missing tools scope', () => event(machine({ scope: 'agent/invoke' }), developer())],
    [
      'wrong user subject',
      () => event(access(), id({ sub: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })),
    ],
    ['missing user subject', () => event(access({ sub: undefined }), id({ sub: undefined }))],
    ['wrong access-token use', () => event(id(), id())],
    ['expired access token', () => event(access({ exp: now() - 10 }), id())],
    ['unsigned developer token', () => event(machine(), developer({}, 'none'))],
    ['wrong developer signature', () => event(machine(), developer({}, 'RS512', true))],
    ['wrong algorithm', () => event(machine(), developer({}, 'RS256'))],
    ['wrong identity pool', () => event(machine(), developer({ aud: 'us-east-1:other-pool' }))],
    ['missing expiry', () => event(machine(), developer({ exp: undefined }))],
    ['expired developer token', () => event(machine(), developer({ exp: now() - 10 }))],
    ['future not-before', () => event(machine(), developer({ nbf: now() + 600 }))],
    ['missing developer subject', () => event(machine(), developer({ sub: undefined }))],
    ['malformed identity', () => event(machine(), developer({ sub: '../../other' }))],
    [
      'issuer lookalike',
      () => event(machine(), developer({ iss: `${developerIssuer}.example.invalid` })),
    ],
  ])('fails closed: %s', async (_name, input) => {
    await expect(handler(input())).rejects.toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('revalidates expired tokens after a successful cache hit', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      const input = event(access(), id({ exp: now() + 1 }));
      await handler(input);
      await handler(input);
      expect(mockSend).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(2000);
      await expect(handler(input)).rejects.toThrow();
      expect(mockSend).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a confused token pair even when the user has a cached identity', async () => {
    await handler(event(access(), id()));
    await expect(handler(event(access(), id({ sub: 'other-user' })))).rejects.toThrow();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('does not forward tool execution when Cognito resolution fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('Cognito unavailable'));
    await expect(handler(event(access(), id()))).rejects.toThrow();
  });

  it('rejects missing verifier configuration', async () => {
    delete process.env.COGNITO_USER_POOL_CLIENT_ID;
    await expect(handler(event(access(), id()))).rejects.toThrow();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('passes tools/list and response events through unchanged', async () => {
    const body = { method: 'tools/list' };
    expect(
      (await handler({ mcp: { gatewayRequest: { body } } })).mcp.transformedGatewayRequest?.body
    ).toEqual(body);
    expect(
      (await handler({ mcp: { gatewayResponse: { body: {}, statusCode: 200 } } })).mcp
        .transformedGatewayResponse
    ).toEqual({ body: {}, statusCode: 200 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
