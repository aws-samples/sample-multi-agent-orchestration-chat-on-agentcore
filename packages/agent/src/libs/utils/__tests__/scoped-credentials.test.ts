/**
 * Long-turn credential lifetime (AC-1, AC-2, AC-3 precondition).
 *
 * Identity Pool credentials live 1 h and the ID token that mints them lives
 * 1 h too, while a turn may run up to the 8 h microVM lifetime. These tests
 * pin the contract that user-scoped SDK clients re-mint before expiry using
 * the freshest ID token known for the session.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const IDENTITY_ID = 'ap-northeast-1:11111111-2222-3333-4444-555555555555';
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

const sendMock = jest.fn<(command: { name: string; input: Record<string, unknown> }) => unknown>();

jest.unstable_mockModule('../../../config/index.js', () => ({
  config: {
    IDENTITY_POOL_ID: 'pool',
    COGNITO_USER_POOL_ID: 'ap-northeast-1_pool',
    AWS_REGION: 'ap-northeast-1',
  },
}));
jest.unstable_mockModule('../../logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@aws-sdk/client-cognito-identity', () => ({
  CognitoIdentityClient: class {
    send = sendMock;
  },
  GetIdCommand: class {
    name = 'GetId';
    constructor(public input: Record<string, unknown>) {}
  },
  GetCredentialsForIdentityCommand: class {
    name = 'GetCredentialsForIdentity';
    constructor(public input: Record<string, unknown>) {}
  },
}));

const {
  createUserScopedS3Client,
  UserCredentialsExpiredError,
  resetUserScopedCredentialCache,
  canObtainUserScopedCredentials,
} = await import('../scoped-credentials.js');
const { recordSessionTokens, resetSessionTokenStore } =
  await import('../../auth/session-token-store.js');
const { createRequestContext, runWithContext } = await import('../../context/request-context.js');

function fakeJwt(expMs: number, sub = 'user-sub'): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({
    sub,
    iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_pool',
    exp: Math.floor(expMs / 1000),
  })}.sig`;
}

let minted = 0;
function credentialCalls() {
  return sendMock.mock.calls.filter(([c]) => c.name === 'GetCredentialsForIdentity');
}

function newRequest(idToken: string, sessionId = 'session-0000000000000000000000000000001') {
  const ctx = createRequestContext('Bearer access');
  ctx.idToken = idToken;
  ctx.sessionId = sessionId as never;
  return ctx;
}

async function resolve(client: { config: { credentials: () => Promise<unknown> } }) {
  return (await client.config.credentials()) as { accessKeyId: string; expiration?: Date };
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  resetUserScopedCredentialCache();
  resetSessionTokenStore();
  minted = 0;
  sendMock.mockReset();
  sendMock.mockImplementation(async (command) => {
    if (command.name === 'GetId') return { IdentityId: IDENTITY_ID };
    minted += 1;
    return {
      Credentials: {
        AccessKeyId: `AKIA${minted}`,
        SecretKey: 'secret',
        SessionToken: 'token',
        Expiration: new Date(Date.now() + 60 * MIN),
      },
    };
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('user-scoped clients refresh credentials during a long turn', () => {
  it('re-mints via GetCredentialsForIdentity once Expiration is < 5 min away', async () => {
    const ctx = newRequest(fakeJwt(T0 + 120 * MIN));
    const client = await runWithContext(ctx, () => createUserScopedS3Client('user-sub'));

    expect((await resolve(client)).accessKeyId).toBe('AKIA1');
    jest.setSystemTime(T0 + 56 * MIN);
    expect((await resolve(client)).accessKeyId).toBe('AKIA2');
    expect(credentialCalls()).toHaveLength(2);
  });

  it('a new request does not inherit cached credentials that expire within the SDK refresh window', async () => {
    await runWithContext(newRequest(fakeJwt(T0 + 60 * MIN)), async () =>
      resolve(await createUserScopedS3Client('user-sub'))
    );

    // Second request in the same microVM, 54 min later: cache has 6 min left.
    jest.setSystemTime(T0 + 54 * MIN);
    const creds = await runWithContext(newRequest(fakeJwt(T0 + 114 * MIN)), async () =>
      resolve(await createUserScopedS3Client('user-sub'))
    );

    expect(creds.expiration!.getTime() - Date.now()).toBeGreaterThan(10 * MIN);
  });

  it('uses an ID token renewed mid-turn for the next refresh', async () => {
    const original = fakeJwt(T0 + 60 * MIN);
    const ctx = newRequest(original);
    const client = await runWithContext(ctx, () => createUserScopedS3Client('user-sub'));
    await resolve(client);

    jest.setSystemTime(T0 + 50 * MIN);
    const renewed = fakeJwt(T0 + 110 * MIN);
    recordSessionTokens(ctx.sessionId!, { idToken: renewed });

    jest.setSystemTime(T0 + 61 * MIN);
    await resolve(client);

    const last = credentialCalls().at(-1)![0].input.Logins as Record<string, string>;
    expect(Object.values(last)).toEqual([renewed]);
  });

  it('fails with a typed error, without calling Cognito, when no unexpired ID token is known', async () => {
    const ctx = newRequest(fakeJwt(T0 + 60 * MIN));
    const client = await runWithContext(ctx, () => createUserScopedS3Client('user-sub'));
    await resolve(client);

    jest.setSystemTime(T0 + 70 * MIN);
    const callsBefore = sendMock.mock.calls.length;
    await expect(resolve(client)).rejects.toBeInstanceOf(UserCredentialsExpiredError);
    expect(sendMock.mock.calls.length).toBe(callsBefore);
  });
});

describe('canObtainUserScopedCredentials', () => {
  it('is true while credentials or an unexpired ID token exist, false once both are gone', async () => {
    const ctx = newRequest(fakeJwt(T0 + 60 * MIN));
    await runWithContext(ctx, async () => resolve(await createUserScopedS3Client('user-sub')));

    jest.setSystemTime(T0 + 55 * MIN);
    expect(canObtainUserScopedCredentials('user-sub', ctx)).toBe(true); // token still valid

    jest.setSystemTime(T0 + 61 * MIN);
    expect(canObtainUserScopedCredentials('user-sub', ctx)).toBe(false);
  });
});
