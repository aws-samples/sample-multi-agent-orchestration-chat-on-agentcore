/**
 * Extended unit tests for auth-resolver.
 *
 * Covers `validateMachineUserScopes`, `validateTargetUserId`, and
 * `resolveEffectiveUserId` edge cases beyond what
 * `invocations.test.ts` exercises. All `RequestContext` instances
 * carry a pre-populated `accessTokenPayload` because the JWT
 * verification step now runs upstream in
 * `requestContextMiddleware` — downstream resolver code must not
 * re-parse or re-verify JWTs.
 */

import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../../config/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  config: {},
}));

const {
  validateMachineUserScopes,
  validateTargetUserId,
  resolveEffectiveUserId,
  REQUIRED_MACHINE_USER_SCOPE,
} = await import('../auth-resolver.js');
import type { RequestContext } from '../../libs/context/request-context.js';
import type { VerifiedAccessTokenPayload } from '../../libs/auth/jwt-verifier.js';
import type { UserId } from '@moca/core';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAccessPayload(
  overrides: Partial<VerifiedAccessTokenPayload> & { sub: string }
): VerifiedAccessTokenPayload {
  return {
    sub: overrides.sub,
    client_id: overrides.client_id ?? 'app-client',
    scope: overrides.scope,
    token_use: 'access',
    exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 3600,
    iss: overrides.iss ?? 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    username: overrides.username,
    raw: overrides.raw ?? {},
  };
}

function machineUserContext(clientId: string, scopes: string[] | undefined): RequestContext {
  return {
    authorizationHeader: 'Bearer access-token',
    requestId: 'req-001',
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

function regularUserContext(userId: string): RequestContext {
  return {
    authorizationHeader: 'Bearer access-token',
    userId: userId as UserId,
    requestId: 'req-002',
    startTime: new Date(),
    isMachineUser: false,
    storagePath: '/',
    clientId: 'web-client',
    accessTokenPayload: buildAccessPayload({
      sub: userId,
      client_id: 'web-client',
      username: userId,
    }),
  };
}

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ANOTHER_UUID = 'd7a41aa8-8031-70e8-4916-4c302e63588a';

// ─── validateMachineUserScopes ─────────────────────────────────────────────────

describe('validateMachineUserScopes', () => {
  it('is invalid when scopes is undefined', () => {
    const result = validateMachineUserScopes(undefined);
    expect(result.valid).toBe(false);
    expect(result.error?.status).toBe(403);
    expect(result.error?.message).toContain(REQUIRED_MACHINE_USER_SCOPE);
  });

  it('is invalid when scopes is an empty array', () => {
    expect(validateMachineUserScopes([]).valid).toBe(false);
  });

  it('lists provided scopes in the error when required scope is missing', () => {
    const result = validateMachineUserScopes(['agent/read', 'agent/write']);
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain('agent/read');
    expect(result.error?.message).toContain('agent/write');
    expect(result.error?.message).toContain(REQUIRED_MACHINE_USER_SCOPE);
  });

  it('is valid when the only scope is the required one', () => {
    expect(validateMachineUserScopes([REQUIRED_MACHINE_USER_SCOPE])).toEqual({ valid: true });
  });

  it('is valid when required scope appears among multiple scopes', () => {
    expect(
      validateMachineUserScopes(['agent/read', REQUIRED_MACHINE_USER_SCOPE, 'agent/admin'])
    ).toEqual({ valid: true });
  });
});

// ─── validateTargetUserId ──────────────────────────────────────────────────────

describe('validateTargetUserId', () => {
  it('rejects empty string', () => {
    const result = validateTargetUserId('');
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain('empty');
  });

  it('rejects whitespace-only string', () => {
    const result = validateTargetUserId('   ');
    expect(result.valid).toBe(false);
  });

  it('rejects tab character', () => {
    expect(validateTargetUserId('\t').valid).toBe(false);
  });

  it('rejects non-UUID string', () => {
    const result = validateTargetUserId('not-a-uuid');
    expect(result.valid).toBe(false);
    expect(result.error?.message).toContain('UUID format');
  });

  it('rejects email address', () => {
    expect(validateTargetUserId('user@example.com').valid).toBe(false);
  });

  it('accepts lowercase UUID', () => {
    expect(validateTargetUserId(VALID_UUID)).toEqual({ valid: true });
  });

  it('accepts uppercase UUID', () => {
    expect(validateTargetUserId(VALID_UUID.toUpperCase())).toEqual({ valid: true });
  });

  it('rejects UUID missing dashes', () => {
    expect(validateTargetUserId('a1b2c3d4e5f67890abcdef1234567890').valid).toBe(false);
  });

  it('rejects UUID with extra segment', () => {
    expect(validateTargetUserId(`${VALID_UUID}-extra`).valid).toBe(false);
  });
});

// ─── resolveEffectiveUserId ────────────────────────────────────────────────────

describe('resolveEffectiveUserId', () => {
  describe('regular user', () => {
    it('returns userId from context', () => {
      expect(resolveEffectiveUserId(regularUserContext(ANOTHER_UUID), undefined)).toEqual({
        userId: ANOTHER_UUID,
      });
    });

    it('fails 401 when context has no accessTokenPayload (middleware bypassed)', () => {
      const ctx: RequestContext = {
        requestId: 'r1',
        startTime: new Date(),
        isMachineUser: false,
        storagePath: '/',
      };
      const result = resolveEffectiveUserId(ctx, undefined);
      expect(result.error?.status).toBe(401);
    });

    it('rejects targetUserId with 403', () => {
      const result = resolveEffectiveUserId(regularUserContext(ANOTHER_UUID), VALID_UUID);
      expect(result.error?.status).toBe(403);
      expect(result.error?.message).toContain('not allowed for regular users');
    });
  });

  describe('machine user', () => {
    it('returns targetUserId when scope is present', () => {
      const ctx = machineUserContext('client-x', [REQUIRED_MACHINE_USER_SCOPE]);
      expect(resolveEffectiveUserId(ctx, VALID_UUID)).toEqual({ userId: VALID_UUID });
    });

    it('returns 400 when targetUserId is missing', () => {
      const ctx = machineUserContext('client-x', [REQUIRED_MACHINE_USER_SCOPE]);
      const result = resolveEffectiveUserId(ctx, undefined);
      expect(result.error?.status).toBe(400);
      expect(result.error?.message).toContain('targetUserId is required');
    });

    it('returns 403 when machine user has no scopes', () => {
      const ctx = machineUserContext('client-x', undefined);
      const result = resolveEffectiveUserId(ctx, VALID_UUID);
      expect(result.error?.status).toBe(403);
      expect(result.error?.message).toContain('Insufficient scope');
    });

    it('returns 403 when required scope is missing', () => {
      const ctx = machineUserContext('client-x', ['agent/read']);
      const result = resolveEffectiveUserId(ctx, VALID_UUID);
      expect(result.error?.status).toBe(403);
    });

    it('returns 400 when targetUserId is malformed', () => {
      const ctx = machineUserContext('client-x', [REQUIRED_MACHINE_USER_SCOPE]);
      const result = resolveEffectiveUserId(ctx, 'bad-user-id');
      expect(result.error?.status).toBe(400);
      expect(result.error?.message).toContain('UUID format');
    });
  });

  describe('pre-authentication failure modes', () => {
    // These cases formerly covered "JWT parsing at resolver time". That
    // responsibility has moved into `requestContextMiddleware`, which
    // populates `accessTokenPayload` only after a successful JWKS
    // verification. Here we prove the resolver fails closed whenever the
    // payload is absent — regardless of what other fields claim.
    it('fails 401 when isMachineUser=true but no accessTokenPayload', () => {
      const ctx: RequestContext = {
        requestId: 'r1',
        startTime: new Date(),
        isMachineUser: true,
        clientId: 'attacker',
        scopes: [REQUIRED_MACHINE_USER_SCOPE],
        storagePath: '/',
      };
      const result = resolveEffectiveUserId(ctx, VALID_UUID);
      expect(result.error?.status).toBe(401);
    });

    it('fails 401 when accessTokenPayload is absent even with Authorization header', () => {
      const ctx: RequestContext = {
        authorizationHeader: 'Bearer whatever',
        requestId: 'r1',
        startTime: new Date(),
        isMachineUser: true,
        storagePath: '/',
      };
      const result = resolveEffectiveUserId(ctx, VALID_UUID);
      expect(result.error?.status).toBe(401);
    });
  });

  describe('null / undefined context', () => {
    it('fails 401 when context is undefined', () => {
      const result = resolveEffectiveUserId(undefined, undefined);
      expect(result.error?.status).toBe(401);
    });

    it('fails 401 when context is undefined and targetUserId is provided', () => {
      // `accessTokenPayload` is the single gate here — without it we
      // never reach the targetUserId check, which is the correct
      // fail-closed behaviour for a fully-unauthenticated request.
      const result = resolveEffectiveUserId(undefined, VALID_UUID);
      expect(result.error?.status).toBe(401);
    });
  });
});
