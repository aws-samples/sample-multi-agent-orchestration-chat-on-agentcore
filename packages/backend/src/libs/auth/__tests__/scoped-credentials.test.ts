/**
 * scoped-credentials tests.
 *
 * Focus: `createAgentCoreClient` takes a plain ID token (not an Express
 * request) and caches Identity Pool credentials by that token. This keeps the
 * libs/auth layer free of any dependency on the middleware `AuthenticatedRequest`
 * type — header extraction is the caller's job.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity', () => ({
  CognitoIdentityClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetIdCommand: jest.fn().mockImplementation((input: unknown) => ({ _type: 'GetId', _input: input })),
  GetCredentialsForIdentityCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ _type: 'GetCreds', _input: input })),
}));

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  AssumeRoleCommand: jest.fn().mockImplementation((input: unknown) => ({ _input: input })),
}));

const mockBedrockAgentCoreClient = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest
    .fn()
    .mockImplementation((cfg: unknown) => mockBedrockAgentCoreClient(cfg)),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((cfg: unknown) => ({ _cfg: cfg })),
}));

jest.mock('../../../config/index', () => ({
  config: {
    AWS_REGION: 'us-east-1',
    IDENTITY_POOL_ID: 'us-east-1:pool',
    COGNITO_USER_POOL_ID: 'us-east-1_pool',
    USER_STORAGE_BUCKET_NAME: 'bucket',
    USER_SCOPED_ROLE_ARN: 'arn:aws:iam::111122223333:role/scoped',
  },
}));

import { createAgentCoreClient } from '../scoped-credentials.js';

const ID_TOKEN = 'header.payload.sig';

function freshCredentials() {
  return {
    AccessKeyId: 'AKIA_TEST',
    SecretKey: 'secret',
    SessionToken: 'token',
    Expiration: new Date(Date.now() + 60 * 60 * 1000),
  };
}

describe('createAgentCoreClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBedrockAgentCoreClient.mockReturnValue({ _client: true });
  });

  it('exchanges the supplied ID token for Identity Pool credentials', async () => {
    mockSend
      .mockResolvedValueOnce({ IdentityId: 'us-east-1:identity-1' } as never)
      .mockResolvedValueOnce({ Credentials: freshCredentials() } as never);

    await createAgentCoreClient(ID_TOKEN);

    const getId = mockSend.mock.calls[0][0] as { _input: { Logins: Record<string, string> } };
    const loginsKey = 'cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';
    expect(getId._input.Logins[loginsKey]).toBe(ID_TOKEN);

    expect(mockBedrockAgentCoreClient).toHaveBeenCalledWith({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', sessionToken: 'token' },
    });
  });

  it('reuses cached credentials for the same ID token (no second GetId)', async () => {
    mockSend
      .mockResolvedValueOnce({ IdentityId: 'us-east-1:identity-2' } as never)
      .mockResolvedValueOnce({ Credentials: freshCredentials() } as never);

    const uniqueToken = `${ID_TOKEN}-cache`;
    await createAgentCoreClient(uniqueToken);
    await createAgentCoreClient(uniqueToken);

    // 2 calls total (GetId + GetCredentials) — the second client build hits cache.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
