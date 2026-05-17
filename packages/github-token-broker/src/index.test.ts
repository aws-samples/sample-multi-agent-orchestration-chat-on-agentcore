/**
 * Unit tests for the GitHub Token Broker handler.
 *
 * @aws-sdk/client-secrets-manager is mocked at the module level so the
 * handler never reaches the real service.
 */

import { jest } from '@jest/globals';

const sendMock = jest.fn();

jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

describe('github-token-broker handler', () => {
  const SECRET_NAME = 'agentcore/test/github-token';

  const loadHandler = async () => {
    jest.resetModules();
    return (await import('./index.js')).handler;
  };

  beforeEach(() => {
    sendMock.mockReset();
    process.env.GITHUB_TOKEN_SECRET_NAME = SECRET_NAME;
  });

  it('returns the token from Secrets Manager for an empty event', async () => {
    sendMock.mockResolvedValueOnce({ SecretString: 'ghp_example' } as never);
    const handler = await loadHandler();

    const result = await handler({});

    expect(result).toEqual({ token: 'ghp_example' });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0] as { input: { SecretId: string } };
    expect(call.input.SecretId).toBe(SECRET_NAME);
  });

  it('ignores SecretId in the caller payload (Confused-Deputy guard)', async () => {
    sendMock.mockResolvedValueOnce({ SecretString: 'ghp_example' } as never);
    const handler = await loadHandler();

    await handler({ SecretId: 'attacker/other-secret' });

    const call = sendMock.mock.calls[0][0] as { input: { SecretId: string } };
    expect(call.input.SecretId).toBe(SECRET_NAME);
  });

  it('returns an empty token when SecretString is missing', async () => {
    sendMock.mockResolvedValueOnce({} as never);
    const handler = await loadHandler();

    const result = await handler({});

    expect(result).toEqual({ token: '' });
  });

  it('throws when GITHUB_TOKEN_SECRET_NAME is not configured', async () => {
    delete process.env.GITHUB_TOKEN_SECRET_NAME;
    const handler = await loadHandler();

    await expect(handler({})).rejects.toThrow('GITHUB_TOKEN_SECRET_NAME is not set');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
