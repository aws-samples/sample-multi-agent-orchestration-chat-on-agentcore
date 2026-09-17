import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier, JwtVerifier } from 'aws-jwt-verify';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetOpenIdTokenForDeveloperIdentityCommand,
  LookupDeveloperIdentityCommand,
} from '@aws-sdk/client-cognito-identity';

jest.mock('@aws-sdk/client-cognito-identity', () => ({
  ...jest.requireActual<object>('@aws-sdk/client-cognito-identity'),
  CognitoIdentityClient: jest.fn(),
}));

jest.mock('../../repositories/sessions/sessions-repository.factory.js', () => ({
  getSessionsRepository: jest.fn(),
}));
jest.mock('../../services/agentcore-memory.js', () => ({
  createAgentCoreMemoryServiceForRequest: jest.fn(),
}));

jest.mock('../../services/s3-storage.js', () => ({
  listStorageItems: jest.fn(),
  getDirectorySize: jest.fn(),
  generateUploadUrl: jest.fn(),
  createDirectory: jest.fn(),
  deleteFile: jest.fn(),
  deleteDirectory: jest.fn(),
  generateDownloadUrl: jest.fn(),
  getFolderTree: jest.fn(),
  getRecursiveDownloadUrls: jest.fn(),
  downloadFile: jest.fn(),
}));

const poolId = 'us-east-1:00000000-0000-0000-0000-000000000000';
const userPoolId = 'us-east-1_testpool';
const issuer = `https://cognito-idp.us-east-1.amazonaws.com/${userPoolId}`;
const developerIssuer = 'https://cognito-identity.amazonaws.com';
const frontendClient = 'frontend-client';
const machineClient = 'machine-client';
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
const listSessions = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getSession = jest.fn<() => Promise<unknown>>();
const deleteSession = jest.fn<() => Promise<void>>();
let app: express.Express;
let storage: typeof import('../../services/s3-storage.js');

function jwt(payload: Record<string, unknown>, algorithm = 'RS256', wrongKey = false) {
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
  return jwt({
    iss: issuer,
    token_use: 'access',
    client_id: frontendClient,
    sub: userA,
    username: 'user-a',
    exp: now() + 600,
    ...overrides,
  });
}

function id(overrides: Record<string, unknown> = {}) {
  return jwt({
    iss: issuer,
    token_use: 'id',
    aud: frontendClient,
    sub: userA,
    exp: now() + 600,
    ...overrides,
  });
}

function machine(overrides: Record<string, unknown> = {}) {
  return access({
    client_id: machineClient,
    sub: machineClient,
    username: undefined,
    scope: 'agent/invoke agent/tools',
    ...overrides,
  });
}

function developer(overrides: Record<string, unknown> = {}, algorithm = 'RS512', wrongKey = false) {
  return jwt(
    { iss: developerIssuer, aud: poolId, sub: identityA, exp: now() + 600, ...overrides },
    algorithm,
    wrongKey
  );
}

async function getStorage(
  accessToken: string,
  idToken: string,
  targetUserId?: string,
  resource = '/storage/list',
  method = 'GET'
) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': idToken,
        ...(targetUserId ? { 'X-Target-User-Id': targetUserId } : {}),
      },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.resetModules();
  Object.assign(process.env, {
    AWS_REGION: 'us-east-1',
    NODE_ENV: 'test',
    COGNITO_REGION: 'us-east-1',
    AGENTCORE_MEMORY_ID: 'memory-id',
    AGENTCORE_SEMANTIC_STRATEGY_ID: 'strategy-id',
    AGENTCORE_GATEWAY_ENDPOINT: 'https://gateway.example',
    USER_STORAGE_BUCKET_NAME: 'bucket',
    AGENTS_TABLE_NAME: 'agents',
    SESSIONS_TABLE_NAME: 'sessions',
    SSM_PARAMETER_PREFIX: '/moca/test',
    TRIGGERS_TABLE_NAME: 'triggers',
    TRIGGER_LAMBDA_ARN: 'arn:aws:lambda:us-east-1:123456789012:function:trigger',
    SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/scheduler',
    IDENTITY_POOL_ID: poolId,
    COGNITO_USER_POOL_ID: userPoolId,
    COGNITO_USER_POOL_CLIENT_ID: frontendClient,
    COGNITO_MACHINE_USER_CLIENT_ID: machineClient,
    DEVELOPER_PROVIDER_NAME: 'moca.trigger',
  });
  const sdk = await import('@aws-sdk/client-cognito-identity');
  mockSend.mockReset().mockImplementation(async (command: unknown) => {
    const name = (command as { constructor?: { name?: string } }).constructor?.name;
    if (command instanceof GetIdCommand || name === 'GetIdCommand')
      return { IdentityId: identityA };
    if (
      command instanceof GetOpenIdTokenForDeveloperIdentityCommand ||
      name === 'GetOpenIdTokenForDeveloperIdentityCommand'
    )
      return { IdentityId: identityA, Token: 'linked' };
    if (
      (command as { constructor?: { name?: string } }).constructor?.name ===
        'LookupDeveloperIdentityCommand' ||
      name === 'LookupDeveloperIdentityCommand'
    )
      return { IdentityId: identityA };
    throw new Error('unexpected command');
  });
  jest
    .mocked(sdk.CognitoIdentityClient, { shallow: true })
    .mockImplementation(
      () => ({ send: mockSend }) as unknown as jest.Mocked<CognitoIdentityClient>
    );
  const jwtLib = await import('aws-jwt-verify');
  const originalCognito = jwtLib.CognitoJwtVerifier.create;
  const originalGeneric = jwtLib.JwtVerifier.create;
  jest.spyOn(jwtLib.CognitoJwtVerifier, 'create').mockImplementation(((
    ...args: Parameters<typeof CognitoJwtVerifier.create>
  ) => {
    const verifier = originalCognito.apply(jwtLib.CognitoJwtVerifier, args);
    verifier.cacheJwks({ keys: [{ ...jwk, alg: 'RS256' }] }, userPoolId);
    return verifier;
  }) as typeof CognitoJwtVerifier.create);
  jest.spyOn(jwtLib.JwtVerifier, 'create').mockImplementation(((
    ...args: Parameters<typeof JwtVerifier.create>
  ) => {
    const verifier = originalGeneric.apply(jwtLib.JwtVerifier, args);
    verifier.cacheJwks({ keys: [{ ...jwk, alg: 'RS512' }] }, developerIssuer);
    return verifier;
  }) as typeof JwtVerifier.create);
  const auth = await import('../auth.js');
  const storageRouter = (await import('../../routes/storage.js')).default;
  storage = await import('../../services/s3-storage.js');
  jest.mocked(storage.listStorageItems).mockResolvedValue({ items: [] } as never);
  const repository = await import('../../repositories/sessions/sessions-repository.factory.js');
  const sessionsRouter = (await import('../../routes/sessions.js')).default;
  listSessions.mockReset().mockResolvedValue({ sessions: [], hasMore: false });
  getSession.mockReset().mockResolvedValue({ sessionId: 'test-session' });
  deleteSession.mockReset().mockResolvedValue(undefined);
  jest.mocked(repository.getSessionsRepository).mockReturnValue({
    isConfigured: () => true,
    listSessions,
    getSession,
    deleteSession,
  } as unknown as ReturnType<typeof repository.getSessionsRepository>);
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { requestId?: string }).requestId = 'test-request';
    next();
  });
  app.use('/storage', auth.authMiddleware, storageRouter);
  app.use('/sessions', auth.authMiddleware, sessionsRouter);
  app.get('/target', auth.authMiddleware, auth.resolveTargetUser, (req, res) =>
    res.json({ targetUserId: (req as { targetUserId?: string }).targetUserId })
  );
});

describe('backend identity boundary with real JWT verification', () => {
  it.each([
    ['GET', '/sessions'],
    ['DELETE', '/sessions/11111111-1111-4111-8111-111111111111'],
  ])('rejects forged identity before DynamoDB access: %s %s', async (method, resource) => {
    for (const accessToken of [access(), machine()]) {
      const response = await getStorage(
        accessToken,
        developer({}, 'none'),
        undefined,
        resource,
        method
      );
      expect(response.status).toBe(401);
    }
    expect(listSessions).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    const memory = await import('../../services/agentcore-memory.js');
    expect(memory.createAgentCoreMemoryServiceForRequest).not.toHaveBeenCalled();
  });

  it('uses the verified identity for the DynamoDB session partition', async () => {
    expect((await getStorage(access(), id(), undefined, '/sessions')).status).toBe(200);
    expect(listSessions).toHaveBeenCalledWith(identityA, 50, undefined);
  });

  it('allows a normal user token pair for the same subject', async () => {
    const response = await getStorage(access(), id());
    expect(response.status).toBe(200);
    expect(storage.listStorageItems).toHaveBeenCalledWith(identityA, '/');
    expect(
      mockSend.mock.calls.some(
        ([command]) =>
          (command as { constructor?: { name?: string } }).constructor?.name === 'GetIdCommand'
      )
    ).toBe(true);
  });

  it('rejects a normal access token paired with a signed developer token', async () => {
    const response = await getStorage(access(), developer());
    expect(response.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
    expect(storage.listStorageItems).not.toHaveBeenCalled();
    expect(
      mockSend.mock.calls.some(
        ([command]) =>
          (command as { constructor?: { name?: string } }).constructor?.name === 'GetIdCommand'
      )
    ).toBe(false);
  });

  it('allows configured machine client with agent/invoke and a signed developer token', async () => {
    const response = await getStorage(machine(), developer());
    expect(response.status).toBe(200);
    expect(storage.listStorageItems).toHaveBeenCalledWith(identityA, '/');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong developer signature', () => [machine(), developer({}, 'RS512', true)]],
    ['wrong developer algorithm', () => [machine(), developer({}, 'RS256')]],
    ['expired access token', () => [machine({ exp: now() - 1 }), developer()]],
    ['missing access expiry', () => [machine({ exp: undefined }), developer()]],
    ['missing normal subject', () => [access({ sub: undefined }), id({ sub: undefined })]],
    ['unsigned developer token', () => [machine(), developer({}, 'none')]],
    ['wrong developer issuer', () => [machine(), developer({ iss: `${developerIssuer}.invalid` })]],
    ['wrong developer audience', () => [machine(), developer({ aud: 'other-pool' })]],
    ['missing developer exp', () => [machine(), developer({ exp: undefined })]],
    ['expired developer token', () => [machine(), developer({ exp: now() - 1 })]],
    ['missing developer sub', () => [machine(), developer({ sub: undefined })]],
    ['invalid developer sub', () => [machine(), developer({ sub: '../../x' })]],
    ['mismatched normal subjects', () => [access(), id({ sub: userB })]],
    ['wrong machine client', () => [machine({ client_id: 'other', sub: 'other' }), developer()]],
    ['machine missing scope', () => [machine({ scope: 'agent/tools' }), developer()]],
  ])('rejects %s before data calls', async (_name, build) => {
    const [accessToken, idToken] = build();
    const response = await getStorage(accessToken, idToken);
    expect(response.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
    expect(storage.listStorageItems).not.toHaveBeenCalled();
    expect(
      mockSend.mock.calls.some(
        ([command]) =>
          (command as { constructor?: { name?: string } }).constructor?.name === 'GetIdCommand'
      )
    ).toBe(false);
  });

  it('rejects an expired cached ID token after an earlier success', async () => {
    jest.useFakeTimers({
      now: new Date('2026-01-01T00:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate'],
    });
    try {
      const accessToken = access({ exp: now() + 10 });
      const idToken = id({ exp: now() + 1 });
      expect((await getStorage(accessToken, idToken)).status).toBe(200);
      expect((await getStorage(accessToken, idToken)).status).toBe(200);
      jest.advanceTimersByTime(2000);
      const response = await getStorage(accessToken, idToken);
      expect(response.status).toBe(401);
      expect(storage.listStorageItems).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps normal and trigger identities legitimate when they resolve to the same identity', async () => {
    expect((await getStorage(access(), id())).status).toBe(200);
    expect((await getStorage(machine(), developer())).status).toBe(200);
    expect(storage.listStorageItems).toHaveBeenNthCalledWith(1, identityA, '/');
    expect(storage.listStorageItems).toHaveBeenNthCalledWith(2, identityA, '/');
  });

  it('uses LookupDeveloperIdentity for machine target-user mapping and caches it for the TTL', async () => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as { port: number };
      const headers = {
        Authorization: `Bearer ${machine()}`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': developer(),
        'X-Target-User-Id': userA,
      };
      const first = await fetch(`http://127.0.0.1:${port}/target`, { headers });
      const second = await fetch(`http://127.0.0.1:${port}/target`, { headers });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const lookups = mockSend.mock.calls.filter(
        ([command]) =>
          (command as { constructor?: { name?: string } }).constructor?.name ===
          'LookupDeveloperIdentityCommand'
      );
      expect(lookups).toHaveLength(1);
      expect((lookups[0][0] as LookupDeveloperIdentityCommand).input).toEqual({
        IdentityPoolId: poolId,
        DeveloperUserIdentifier: userA,
        MaxResults: 1,
      });
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      try {
        const afterExpiry = await fetch(`http://127.0.0.1:${port}/target`, { headers });
        expect(afterExpiry.status).toBe(200);
        expect(
          mockSend.mock.calls.filter(
            ([command]) =>
              (command as { constructor: { name: string } }).constructor.name ===
              'LookupDeveloperIdentityCommand'
          )
        ).toHaveLength(2);
      } finally {
        clock.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects target-user mapping mismatch or Cognito failure', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (
        (command as { constructor?: { name?: string } }).constructor?.name ===
        'LookupDeveloperIdentityCommand'
      )
        return { IdentityId: identityB };
      throw new Error('unexpected command');
    });
    const mismatch = await new Promise<{ status: number }>((resolve) => {
      const server = app.listen(0, async () => {
        const { port } = server.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${port}/target`, {
          headers: {
            Authorization: `Bearer ${machine()}`,
            'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': developer(),
            'X-Target-User-Id': userA,
          },
        });
        server.close(() => resolve({ status: response.status }));
      });
    });
    expect(mismatch.status).toBe(401);
    mockSend.mockRejectedValueOnce(new Error('lookup failed'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/target`, {
        headers: {
          Authorization: `Bearer ${machine()}`,
          'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': developer({ sub: identityB }),
          'X-Target-User-Id': userA,
        },
      });
      expect(response.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
