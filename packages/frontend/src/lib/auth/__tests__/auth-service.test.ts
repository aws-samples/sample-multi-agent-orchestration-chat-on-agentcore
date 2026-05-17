/**
 * Unit tests for auth-service.ts.
 *
 * Focus on the failure modes that were impossible to test against the
 * legacy `amazon-cognito-identity-js` wrapper:
 *   1. `getTokens({ forceRefresh: true })` must call Amplify's
 *      `fetchAuthSession` with `forceRefresh: true`.
 *   2. `getTokens()` must throw `NotAuthenticatedError` when the session
 *      has no tokens, so API clients can distinguish "retry with refresh"
 *      from "permanent auth failure".
 *   3. `onAuthEvent` must translate Amplify Hub events into the narrower
 *      app-level `AuthEvent` shape.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---- Mocks ------------------------------------------------------------

// Hub listener registered by auth-service
type HubPayloadListener = (arg: { payload: { event: string; data?: unknown } }) => unknown;
let hubListener: HubPayloadListener | null = null;

vi.mock('aws-amplify/utils', () => ({
  Hub: {
    listen: (_channel: string, listener: HubPayloadListener) => {
      hubListener = listener;
      return () => {
        hubListener = null;
      };
    },
  },
}));

const fetchAuthSession = vi.fn();
const signIn = vi.fn();
const signOut = vi.fn();
const signUp = vi.fn();
const confirmSignUp = vi.fn();
const resendSignUpCode = vi.fn();
const resetPassword = vi.fn();
const confirmResetPassword = vi.fn();
const confirmSignIn = vi.fn();
const getCurrentUser = vi.fn();

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession,
  signIn,
  signOut,
  signUp,
  confirmSignUp,
  resendSignUpCode,
  resetPassword,
  confirmResetPassword,
  confirmSignIn,
  getCurrentUser,
}));

// ---- Helpers ----------------------------------------------------------

function makeToken(payload: unknown): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${b64}.signature`;
}

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function tokensPayload(sub: string, exp = Math.floor(Date.now() / 1000) + 3600) {
  const accessJwt = makeToken({ sub, exp, username: 'alice' });
  const idJwt = makeToken({ sub, exp });
  return {
    tokens: {
      accessToken: {
        toString: () => accessJwt,
        payload: { sub, exp, username: 'alice' },
      },
      idToken: {
        toString: () => idJwt,
        payload: { sub, exp },
      },
    },
  };
}

// ---- Module under test -----------------------------------------------

let authServiceMod: typeof import('../auth-service');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  hubListener = null;
  authServiceMod = await import('../auth-service');
});

// -----------------------------------------------------------------------
describe('authService.getTokens', () => {
  it('returns accessToken, idToken, and userId from the session', async () => {
    fetchAuthSession.mockResolvedValueOnce(tokensPayload(USER_ID));

    const tokens = await authServiceMod.authService.getTokens();

    expect(tokens.userId).toBe(USER_ID);
    expect(tokens.accessToken).toContain('.'); // JWT
    expect(tokens.idToken).toContain('.'); // JWT
    expect(fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: undefined });
  });

  it('throws NotAuthenticatedError when the session has no tokens (signed-out)', async () => {
    fetchAuthSession.mockResolvedValueOnce({ tokens: undefined });

    await expect(authServiceMod.authService.getTokens()).rejects.toBeInstanceOf(
      authServiceMod.NotAuthenticatedError
    );
  });

  it('throws NotAuthenticatedError when fetchAuthSession itself rejects', async () => {
    fetchAuthSession.mockRejectedValueOnce(new Error('network down'));

    await expect(authServiceMod.authService.getTokens()).rejects.toBeInstanceOf(
      authServiceMod.NotAuthenticatedError
    );
  });

  it('passes forceRefresh: true through to fetchAuthSession when requested', async () => {
    fetchAuthSession.mockResolvedValueOnce(tokensPayload(USER_ID));

    await authServiceMod.authService.getTokens({ forceRefresh: true });

    expect(fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true });
  });
});

// -----------------------------------------------------------------------
describe('authService.currentUser', () => {
  it('returns a User when a session exists', async () => {
    fetchAuthSession.mockResolvedValueOnce(tokensPayload(USER_ID));
    (getCurrentUser as Mock).mockResolvedValueOnce({ username: 'alice' });

    const user = await authServiceMod.authService.currentUser();
    expect(user).toEqual({ userId: USER_ID, username: 'alice' });
  });

  it('returns null when Amplify has no session (never throws)', async () => {
    fetchAuthSession.mockResolvedValueOnce({ tokens: undefined });

    const user = await authServiceMod.authService.currentUser();
    expect(user).toBeNull();
  });

  it('returns null when fetchAuthSession throws (bootstrap safe)', async () => {
    fetchAuthSession.mockRejectedValueOnce(new Error('network'));

    // currentUser catches internally — it is called at app bootstrap and
    // must not break the app shell just because there is no session.
    const user = await authServiceMod.authService.currentUser();
    expect(user).toBeNull();
  });
});

// -----------------------------------------------------------------------
describe('authService.signIn', () => {
  it('returns { kind: "success" } when isSignedIn is true', async () => {
    signIn.mockResolvedValueOnce({
      isSignedIn: true,
      nextStep: { signInStep: 'DONE' },
    });
    fetchAuthSession.mockResolvedValueOnce(tokensPayload(USER_ID));
    (getCurrentUser as Mock).mockResolvedValueOnce({ username: 'alice' });

    const result = await authServiceMod.authService.signIn('alice', 'pw');
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.user.userId).toBe(USER_ID);
    }
  });

  it('returns { kind: "newPasswordRequired" } when Amplify asks for a new password', async () => {
    signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
    });

    const result = await authServiceMod.authService.signIn('alice', 'pw');
    expect(result.kind).toBe('newPasswordRequired');
  });

  it('returns { kind: "confirmSignUpRequired" } when email verification is pending', async () => {
    signIn.mockResolvedValueOnce({
      isSignedIn: false,
      nextStep: { signInStep: 'CONFIRM_SIGN_UP' },
    });

    const result = await authServiceMod.authService.signIn('alice', 'pw');
    expect(result.kind).toBe('confirmSignUpRequired');
  });
});

// -----------------------------------------------------------------------
describe('authService.onAuthEvent', () => {
  it('translates Amplify "signedIn" into app-level AuthEvent', async () => {
    fetchAuthSession.mockResolvedValueOnce(tokensPayload(USER_ID));
    (getCurrentUser as Mock).mockResolvedValueOnce({ username: 'alice' });

    const events: unknown[] = [];
    authServiceMod.authService.onAuthEvent((e) => events.push(e));

    expect(hubListener).not.toBeNull();
    await hubListener!({ payload: { event: 'signedIn' } });

    expect(events).toEqual([{ type: 'signedIn', user: { userId: USER_ID, username: 'alice' } }]);
  });

  it('emits "signedOut" and "sessionEnded" on Amplify signedOut', async () => {
    const events: { type: string }[] = [];
    authServiceMod.authService.onAuthEvent((e) => events.push(e));

    await hubListener!({ payload: { event: 'signedOut' } });
    expect(events.map((e) => e.type)).toEqual(['signedOut', 'sessionEnded']);
  });

  it('emits "sessionEnded" with reason "refreshFailed" when Amplify cannot refresh', async () => {
    const events: unknown[] = [];
    authServiceMod.authService.onAuthEvent((e) => events.push(e));

    await hubListener!({ payload: { event: 'tokenRefresh_failure' } });
    expect(events).toEqual([{ type: 'sessionEnded', reason: 'refreshFailed' }]);
  });

  it('does not emit anything on successful tokenRefresh (silent)', async () => {
    const events: unknown[] = [];
    authServiceMod.authService.onAuthEvent((e) => events.push(e));

    await hubListener!({ payload: { event: 'tokenRefresh' } });
    expect(events).toEqual([]);
  });
});
