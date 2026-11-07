/**
 * Event-driven turns have no frontend to renew tokens, so the developer-auth
 * OpenID token must stay valid for the whole turn: the agent runtime re-mints
 * the user's Identity Pool credentials with it every ~55 min. The default
 * (15 min) made a trigger turn lose persistence after its first credentials
 * expired.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const sendMock = jest.fn<(command: { input: Record<string, unknown> }) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-cognito-identity', () => ({
  CognitoIdentityClient: class {
    send = sendMock;
  },
  GetOpenIdTokenForDeveloperIdentityCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { AuthService, DEVELOPER_TOKEN_DURATION_SECONDS } = await import('../auth-service.js');

beforeEach(() => {
  process.env.IDENTITY_POOL_ID = 'pool';
  process.env.DEVELOPER_PROVIDER_NAME = 'moca.dev';
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    Token: 'tok',
    IdentityId: 'ap-northeast-1:11111111-2222-3333-4444-555555555555',
  });
});

describe('AuthService.getOpenIdTokenForUser', () => {
  it('requests a developer-auth token that outlives an AgentCore session (8 h)', async () => {
    const service = new AuthService({
      cognitoDomain: 'd',
      clientId: 'c',
      clientSecret: 's',
    } as never);

    await service.getOpenIdTokenForUser('user');

    expect(DEVELOPER_TOKEN_DURATION_SECONDS).toBe(8 * 60 * 60);
    expect(sendMock.mock.calls[0][0].input.TokenDuration).toBe(DEVELOPER_TOKEN_DURATION_SECONDS);
  });
});
