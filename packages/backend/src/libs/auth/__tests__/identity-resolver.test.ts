/**
 * Identity Resolver Tests
 *
 * Verifies that `resolveIdentityId` correctly branches on the ID Token type:
 *   - UserPool ID Token    → calls `GetId`
 *   - Developer-auth Token → reads `sub` directly, MUST NOT call `GetId`
 *
 * The developer-auth branch is the fix for event-driven invocations where the
 * Agent forwards a developer-auth OpenID Token to the Backend; calling `GetId`
 * on that token throws `NotAuthorizedException: Invalid login token.` — which
 * previously caused Backend `/agents` calls from the `call_agent` tool to
 * fail with 401 and return an empty agent list.
 *
 * Additionally verifies the fire-and-forget `linkDeveloperAuthToIdentity`
 * side effect that the backend performs on UserPool ID Tokens. This link
 * permanently associates the developer login `{ DEVELOPER_PROVIDER_NAME:
 * userPoolSub }` with the Identity Pool identity A — preventing Trigger
 * Lambda from creating a second identity on the first event fire.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mutable config mock so individual tests can toggle `DEVELOPER_PROVIDER_NAME`
// to exercise both the link-enabled and link-disabled code paths.
const mockConfig: {
  AWS_REGION: string;
  COGNITO_USER_POOL_ID: string;
  IDENTITY_POOL_ID: string;
  DEVELOPER_PROVIDER_NAME?: string;
} = {
  AWS_REGION: 'us-east-1',
  COGNITO_USER_POOL_ID: 'us-east-1_testpool',
  IDENTITY_POOL_ID: 'us-east-1:00000000-0000-0000-0000-000000000000',
  DEVELOPER_PROVIDER_NAME: undefined,
};

jest.mock('../../../config/index.js', () => ({
  // Return a Proxy so mutations to `mockConfig` take effect even for readers
  // that destructure at import time.
  get config() {
    return mockConfig;
  },
}));

// Mock the AWS SDK client so we can assert on call shape without
// network I/O. `mockSend` is declared here so the mock factory below can
// reference it lazily at construction time.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity', () => ({
  CognitoIdentityClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  GetIdCommand: jest.fn().mockImplementation((input: unknown) => ({
    _commandName: 'GetIdCommand',
    _input: input,
  })),
  GetOpenIdTokenForDeveloperIdentityCommand: jest.fn().mockImplementation((input: unknown) => ({
    _commandName: 'GetOpenIdTokenForDeveloperIdentityCommand',
    _input: input,
  })),
}));

import { resolveIdentityId, __resetCachesForTests } from '../identity-resolver.js';
import {
  GetIdCommand,
  GetOpenIdTokenForDeveloperIdentityCommand,
} from '@aws-sdk/client-cognito-identity';

const MockGetIdCommand = jest.mocked(GetIdCommand);
const MockGetOpenIdTokenForDeveloperIdentityCommand = jest.mocked(
  GetOpenIdTokenForDeveloperIdentityCommand
);

/**
 * Build a base64url-encoded JWT with the given payload. Signature is a
 * dummy value because we only decode, never verify.
 */
function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

/**
 * Wait for pending fire-and-forget microtasks to settle. The link call is
 * issued from a non-awaited `void (async () => {})()` block, so the Promise
 * resolves on a later microtask tick.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('resolveIdentityId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetCachesForTests();
    mockConfig.DEVELOPER_PROVIDER_NAME = undefined;
  });

  describe('UserPool ID Token (frontend flow)', () => {
    it('calls GetId and returns the resolved identityId', async () => {
      const idToken = buildJwt({
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool',
        sub: 'd7a41aa8-8031-70e8-4916-4c302e63588a',
        token_use: 'id',
      });
      const expectedIdentityId = 'us-east-1:d7a41aa8-8031-70e8-4916-4c302e63588a';
      mockSend.mockResolvedValueOnce({ IdentityId: expectedIdentityId } as never);

      const result = await resolveIdentityId(idToken);

      expect(result).toBe(expectedIdentityId);
      expect(MockGetIdCommand).toHaveBeenCalledTimes(1);
      const callArg = MockGetIdCommand.mock.calls[0][0] as {
        IdentityPoolId: string;
        Logins: Record<string, string>;
      };
      expect(callArg.IdentityPoolId).toBe('us-east-1:00000000-0000-0000-0000-000000000000');
      expect(callArg.Logins).toEqual({
        'cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool': idToken,
      });
    });

    it('throws when GetId returns no IdentityId', async () => {
      const idToken = buildJwt({
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool',
      });
      mockSend.mockResolvedValueOnce({} as never);

      await expect(resolveIdentityId(idToken)).rejects.toThrow(
        'GetId did not return an IdentityId'
      );
    });
  });

  describe('Developer-auth OpenID Token (event-driven flow)', () => {
    it('uses `sub` as the identityId and does NOT call GetId', async () => {
      const identityId = 'us-east-1:e6224b58-1111-2222-3333-444455556666';
      const idToken = buildJwt({
        iss: 'https://cognito-identity.amazonaws.com',
        sub: identityId,
        aud: 'us-east-1:00000000-0000-0000-0000-000000000000',
      });

      const result = await resolveIdentityId(idToken);

      expect(result).toBe(identityId);
      // Critical: GetId must NOT be invoked because Cognito rejects
      // developer-auth tokens with `NotAuthorizedException`.
      expect(MockGetIdCommand).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('throws when developer-auth token is missing `sub`', async () => {
      const idToken = buildJwt({
        iss: 'https://cognito-identity.amazonaws.com',
      });

      await expect(resolveIdentityId(idToken)).rejects.toThrow(
        'Developer-auth OpenID Token is missing `sub` claim (identityId)'
      );
      expect(MockGetIdCommand).not.toHaveBeenCalled();
    });

    it('throws when developer-auth `sub` is not a valid identityId format', async () => {
      const idToken = buildJwt({
        iss: 'https://cognito-identity.amazonaws.com',
        sub: 'not-an-identity-id',
      });

      await expect(resolveIdentityId(idToken)).rejects.toThrow(/Invalid identityId/);
    });
  });

  describe('caching', () => {
    it('caches the result keyed by the raw token string', async () => {
      // Use a fresh token each test run so this suite is order-independent.
      const idToken = buildJwt({
        iss: 'https://cognito-identity.amazonaws.com',
        sub: 'us-east-1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nonce: `${Date.now()}-${Math.random()}`,
      });

      const first = await resolveIdentityId(idToken);
      const second = await resolveIdentityId(idToken);

      expect(first).toBe(second);
      // Developer-auth path never calls GetId; the cache hit obviously
      // doesn't call it either. The assertion still guards against a
      // future refactor accidentally re-invoking GetId.
      expect(MockGetIdCommand).not.toHaveBeenCalled();
    });
  });

  describe('linkDeveloperAuthToIdentity (side effect on UserPool tokens)', () => {
    const userPoolSub = 'd7a41aa8-8031-70e8-4916-4c302e63588a';
    const identityId = 'us-east-1:d7a41aa8-8031-70e8-4916-4c302e63588a';
    const userPoolIdToken = (): string =>
      buildJwt({
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool',
        sub: userPoolSub,
        token_use: 'id',
        // Unique nonce so tokens differ between tests that both use this helper.
        nonce: `${Date.now()}-${Math.random()}`,
      });

    it('does NOT call GetOpenIdTokenForDeveloperIdentity when DEVELOPER_PROVIDER_NAME is unset', async () => {
      mockConfig.DEVELOPER_PROVIDER_NAME = undefined;
      const idToken = userPoolIdToken();
      mockSend.mockResolvedValueOnce({ IdentityId: identityId } as never);

      await resolveIdentityId(idToken);
      await flushMicrotasks();

      expect(MockGetOpenIdTokenForDeveloperIdentityCommand).not.toHaveBeenCalled();
    });

    it('calls GetOpenIdTokenForDeveloperIdentity with the UserPool login + developer login when configured', async () => {
      mockConfig.DEVELOPER_PROVIDER_NAME = 'moca.trigger';
      const idToken = userPoolIdToken();
      // First send() is GetId, second is GetOpenIdTokenForDeveloperIdentity.
      mockSend
        .mockResolvedValueOnce({ IdentityId: identityId } as never)
        .mockResolvedValueOnce({ Token: 'dummy-openid-token', IdentityId: identityId } as never);

      await resolveIdentityId(idToken);
      await flushMicrotasks();

      expect(MockGetOpenIdTokenForDeveloperIdentityCommand).toHaveBeenCalledTimes(1);
      const linkArg = MockGetOpenIdTokenForDeveloperIdentityCommand.mock.calls[0][0] as {
        IdentityPoolId: string;
        IdentityId: string;
        Logins: Record<string, string>;
      };
      expect(linkArg.IdentityPoolId).toBe('us-east-1:00000000-0000-0000-0000-000000000000');
      expect(linkArg.IdentityId).toBe(identityId);
      expect(linkArg.Logins).toEqual({
        'cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool': idToken,
        'moca.trigger': userPoolSub,
      });
    });

    it('links only once per token (subsequent calls short-circuit via linkedTokens guard)', async () => {
      mockConfig.DEVELOPER_PROVIDER_NAME = 'moca.trigger';
      const idToken = userPoolIdToken();
      mockSend
        .mockResolvedValueOnce({ IdentityId: identityId } as never)
        .mockResolvedValueOnce({ Token: 'dummy-openid-token', IdentityId: identityId } as never);

      await resolveIdentityId(idToken);
      await flushMicrotasks();
      // Second call hits the cache; link must not be re-issued.
      await resolveIdentityId(idToken);
      await flushMicrotasks();

      expect(MockGetOpenIdTokenForDeveloperIdentityCommand).toHaveBeenCalledTimes(1);
    });

    it('resolves the caller even when the link call fails (fire-and-forget)', async () => {
      mockConfig.DEVELOPER_PROVIDER_NAME = 'moca.trigger';
      const idToken = userPoolIdToken();
      mockSend
        .mockResolvedValueOnce({ IdentityId: identityId } as never)
        .mockRejectedValueOnce(new Error('Simulated Cognito failure') as never);

      const result = await resolveIdentityId(idToken);
      await flushMicrotasks();

      expect(result).toBe(identityId);
      expect(MockGetOpenIdTokenForDeveloperIdentityCommand).toHaveBeenCalledTimes(1);
    });

    it('does NOT attempt to link on developer-auth tokens (no UserPool idToken available)', async () => {
      mockConfig.DEVELOPER_PROVIDER_NAME = 'moca.trigger';
      const idToken = buildJwt({
        iss: 'https://cognito-identity.amazonaws.com',
        sub: 'us-east-1:f99aab12-3333-4444-5555-666677778888',
      });

      await resolveIdentityId(idToken);
      await flushMicrotasks();

      expect(MockGetOpenIdTokenForDeveloperIdentityCommand).not.toHaveBeenCalled();
    });
  });
});
