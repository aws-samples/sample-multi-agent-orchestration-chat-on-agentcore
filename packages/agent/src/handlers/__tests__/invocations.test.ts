/**
 * Invocations Handler Tests
 *
 * These tests exercise `resolveEffectiveUserId` and the scope /
 * target-user-id validators that run *after* JWT verification. The
 * context fed in here is therefore assumed to be post-verification —
 * we construct it with a synthetic `accessTokenPayload` that mimics
 * what `requestContextMiddleware` would populate.
 *
 * Tests for the verifier itself live in
 * `libs/auth/__tests__/jwt-verifier.test.ts`, which uses
 * `aws-jwt-verify` module mocks.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { UserId } from '@moca/core';

jest.unstable_mockModule('../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));

const {
  resolveEffectiveUserId,
  validateMachineUserScopes,
  validateTargetUserId,
  REQUIRED_MACHINE_USER_SCOPE,
} = await import('../auth-resolver.js');
import type { RequestContext } from '../../libs/context/request-context.js';
import type { VerifiedAccessTokenPayload } from '../../libs/auth/jwt-verifier.js';

// Canonical UUID-shaped ids — required to satisfy the `UserId` brand.
const USER_UUID = 'd7a41aa8-8031-70e8-4916-4c302e63588a';
const TARGET_USER_UUID = '47547a38-70e1-7026-e25f-bbdc98c68d68';

/**
 * Build a verified-access-token payload suitable for stubbing into the
 * `RequestContext`. The shape mirrors what
 * `libs/auth/jwt-verifier.ts#verifyAccessToken` returns after a
 * successful JWKS verification.
 */
function buildAccessPayload(
  overrides: Partial<VerifiedAccessTokenPayload> & { sub: string }
): VerifiedAccessTokenPayload {
  return {
    sub: overrides.sub,
    client_id: overrides.client_id ?? 'app-client-id',
    scope: overrides.scope,
    token_use: 'access',
    exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 3600,
    iss: overrides.iss ?? 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    username: overrides.username,
    raw: overrides.raw ?? {},
  };
}

function createRegularUserContext(userId: string = USER_UUID): RequestContext {
  return {
    authorizationHeader: 'Bearer access-token',
    userId: userId as UserId,
    requestId: 'test-request-id',
    startTime: new Date(),
    isMachineUser: false,
    storagePath: '/',
    clientId: 'app-client-id',
    accessTokenPayload: buildAccessPayload({
      sub: userId,
      client_id: 'app-client-id',
      username: userId,
    }),
  };
}

function createMachineUserContext(clientId: string, scopes?: string[]): RequestContext {
  return {
    authorizationHeader: 'Bearer access-token',
    requestId: 'test-request-id',
    startTime: new Date(),
    isMachineUser: true,
    clientId,
    scopes,
    storagePath: '/',
    accessTokenPayload: buildAccessPayload({
      sub: clientId,
      client_id: clientId,
      scope: scopes?.join(' '),
    }),
  };
}

describe('resolveEffectiveUserId', () => {
  describe('regular user (Authorization Code Flow)', () => {
    it('returns userId from context for regular user', () => {
      const context = createRegularUserContext(USER_UUID);
      const result = resolveEffectiveUserId(context, undefined);

      expect(result).toEqual({ userId: USER_UUID });
    });

    it('fails with 401 for regular user without userId (anonymous no longer allowed)', () => {
      const context: RequestContext = {
        authorizationHeader: undefined,
        requestId: 'test-request-id',
        startTime: new Date(),
        isMachineUser: false,
        storagePath: '/',
        // No accessTokenPayload — JWT verification never ran.
      };
      const result = resolveEffectiveUserId(context, undefined);

      expect(result.userId).toBeUndefined();
      expect(result.error?.status).toBe(401);
      expect(result.error?.message).toContain('user ID could not be resolved');
    });

    it('returns 403 error if regular user tries to use targetUserId', () => {
      const context = createRegularUserContext(USER_UUID);
      const result = resolveEffectiveUserId(context, TARGET_USER_UUID);

      expect(result).toEqual({
        error: {
          status: 403,
          message: 'targetUserId is not allowed for regular users',
        },
      });
    });
  });

  describe('machine user (Client Credentials Flow)', () => {
    it('returns targetUserId for machine user with valid scope', () => {
      const context = createMachineUserContext('machine-client-id', [REQUIRED_MACHINE_USER_SCOPE]);
      const result = resolveEffectiveUserId(context, TARGET_USER_UUID);

      expect(result).toEqual({ userId: TARGET_USER_UUID });
    });

    it('returns 403 if machine user has no scopes', () => {
      const context = createMachineUserContext('machine-client-id', undefined);
      const result = resolveEffectiveUserId(context, TARGET_USER_UUID);

      expect(result).toEqual({
        error: {
          status: 403,
          message: `Insufficient scope: '${REQUIRED_MACHINE_USER_SCOPE}' scope is required for machine user invocation`,
        },
      });
    });

    it('returns 403 if machine user has empty scopes array', () => {
      const context = createMachineUserContext('machine-client-id', []);
      const result = resolveEffectiveUserId(context, TARGET_USER_UUID);

      expect(result.error?.status).toBe(403);
    });

    it('returns 403 if machine user has wrong scopes', () => {
      const context = createMachineUserContext('machine-client-id', ['agent/tools', 'agent/admin']);
      const result = resolveEffectiveUserId(context, TARGET_USER_UUID);

      expect(result.error?.status).toBe(403);
      expect(result.error?.message).toContain('agent/tools');
    });

    it('returns 400 if machine user does not provide targetUserId', () => {
      const context = createMachineUserContext('machine-client-id', [REQUIRED_MACHINE_USER_SCOPE]);
      const result = resolveEffectiveUserId(context, undefined);

      expect(result).toEqual({
        error: {
          status: 400,
          message: 'targetUserId is required for machine user (Client Credentials Flow)',
        },
      });
    });

    it('returns 400 if targetUserId is not a valid UUID', () => {
      const context = createMachineUserContext('machine-client-id', [REQUIRED_MACHINE_USER_SCOPE]);
      const result = resolveEffectiveUserId(context, 'invalid-user-id');

      expect(result.error?.status).toBe(400);
      expect(result.error?.message).toContain('UUID format');
    });

    it('returns 400 if targetUserId is email format (not allowed)', () => {
      const context = createMachineUserContext('machine-client-id', [REQUIRED_MACHINE_USER_SCOPE]);
      const result = resolveEffectiveUserId(context, 'user@example.com');

      expect(result.error?.status).toBe(400);
    });
  });

  describe('pre-authentication calls', () => {
    // Once JWT verification moves up into `requestContextMiddleware`,
    // reaching `resolveEffectiveUserId` without a verified
    // `accessTokenPayload` means the middleware chain was bypassed —
    // we must fail closed.
    it('fails 401 if context has no accessTokenPayload', () => {
      const context: RequestContext = {
        authorizationHeader: 'Bearer whatever',
        requestId: 'test-request-id',
        startTime: new Date(),
        isMachineUser: false,
        storagePath: '/',
      };
      const result = resolveEffectiveUserId(context, undefined);

      expect(result.userId).toBeUndefined();
      expect(result.error?.status).toBe(401);
    });

    it('returns 401 for undefined context', () => {
      const result = resolveEffectiveUserId(undefined, undefined);
      expect(result.userId).toBeUndefined();
      expect(result.error?.status).toBe(401);
    });
  });
});

describe('validateMachineUserScopes', () => {
  it('returns valid for correct scope', () => {
    expect(validateMachineUserScopes([REQUIRED_MACHINE_USER_SCOPE])).toEqual({ valid: true });
  });

  it('returns valid when required scope is among multiple scopes', () => {
    expect(
      validateMachineUserScopes(['agent/tools', REQUIRED_MACHINE_USER_SCOPE, 'agent/admin'])
    ).toEqual({ valid: true });
  });

  it('returns error for undefined scopes', () => {
    const result = validateMachineUserScopes(undefined);
    expect(result.valid).toBe(false);
    expect(result.error?.status).toBe(403);
  });

  it('returns error for empty scopes array', () => {
    const result = validateMachineUserScopes([]);
    expect(result.valid).toBe(false);
  });

  it('returns error when required scope is missing', () => {
    const result = validateMachineUserScopes(['agent/tools', 'agent/admin']);
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain('agent/tools');
    expect(result.error?.message).toContain('agent/admin');
  });
});

describe('validateTargetUserId', () => {
  it('accepts valid UUID', () => {
    expect(validateTargetUserId('47547a38-70e1-7026-e25f-bbdc98c68d68')).toEqual({ valid: true });
  });

  it('accepts UUID with uppercase letters', () => {
    expect(validateTargetUserId('47547A38-70E1-7026-E25F-BBDC98C68D68')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateTargetUserId('');
    expect(result.valid).toBe(false);
    expect(result.error?.status).toBe(400);
  });

  it('rejects whitespace-only string', () => {
    const result = validateTargetUserId('   ');
    expect(result.valid).toBe(false);
  });

  it('rejects non-UUID format', () => {
    const result = validateTargetUserId('not-a-uuid');
    expect(result.valid).toBe(false);
  });

  it('rejects email format', () => {
    const result = validateTargetUserId('user@example.com');
    expect(result.valid).toBe(false);
  });

  it('rejects extra characters', () => {
    const result = validateTargetUserId('47547a38-70e1-7026-e25f-bbdc98c68d68-extra');
    expect(result.valid).toBe(false);
  });

  it('rejects non-hex characters', () => {
    const result = validateTargetUserId('47547g38-70e1-7026-e25f-bbdc98c68d68');
    expect(result.valid).toBe(false);
  });
});
