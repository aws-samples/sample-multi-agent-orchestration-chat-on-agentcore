/**
 * Framework-agnostic Auth Service.
 *
 * Thin wrapper over Amplify v6 Auth that:
 *   - Normalizes the tokens shape the API layer cares about (access + id + userId).
 *   - Centralizes sign-in / sign-out / password flows so UI layers never
 *     import `aws-amplify/auth` directly (makes UI easier to test and keeps
 *     any future Auth-provider swap localized to this file).
 *   - Provides a typed event subscription over Amplify's `Hub` for the
 *     React context layer.
 *
 * This file must be imported AFTER `configure.ts` has executed.
 */
import {
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  signUp as amplifySignUp,
  confirmSignUp as amplifyConfirmSignUp,
  resendSignUpCode as amplifyResendSignUpCode,
  resetPassword as amplifyResetPassword,
  confirmResetPassword as amplifyConfirmResetPassword,
  confirmSignIn as amplifyConfirmSignIn,
  fetchAuthSession,
  getCurrentUser,
  type SignInOutput,
} from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';

import type { UserId } from '@moca/core';
import { parseUserId } from '@moca/core';
import { logger } from '../../utils/logger';
import type { User } from '../../types/index';
import { extractUserIdFromAccessToken } from '../jwt';

/**
 * Tokens bundled together for a single API call.
 *
 * WHY we expose `idToken` in addition to `accessToken`: the AgentCore Runtime
 * requires the Cognito id token (not the access token) in the custom header
 * for Identity Pool `GetCredentialsForIdentity` exchange.
 */
export interface AuthTokens {
  accessToken: string;
  idToken: string;
  userId: UserId;
  /** Unix ms at which the access token expires. Useful for proactive refresh / debug. */
  expiresAt: number;
}

/**
 * Result of `signIn()`. We deliberately narrow Amplify's `SignInOutput` so
 * callers don't need to understand Amplify-specific challenge names.
 */
export type SignInResult =
  | { kind: 'success'; user: User }
  | { kind: 'newPasswordRequired' }
  | { kind: 'confirmSignUpRequired'; username: string };

/**
 * Auth events surfaced to the application.
 *
 * Amplify's Hub emits many events (signedIn, signedOut, tokenRefresh,
 * tokenRefresh_failure, etc.). We re-emit only the ones the UI cares about
 * and collapse `tokenRefresh_failure` + `signedOut` to the single concept
 * of "session ended" so the UI doesn't have to distinguish.
 */
export type AuthEvent =
  | { type: 'signedIn'; user: User }
  | { type: 'signedOut' }
  | { type: 'sessionEnded'; reason: 'refreshFailed' | 'revoked' | 'signedOut' };

export type AuthEventListener = (event: AuthEvent) => void;

class NotAuthenticatedError extends Error {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

export { NotAuthenticatedError };

/**
 * Build a User from the current session tokens.
 *
 * WHY we parse `userId` from the access token (not from Amplify's
 * `getCurrentUser()`): access-token `sub` is the canonical authoritative id
 * that backend services verify; aligning the UI with that value eliminates
 * any drift between what the frontend thinks it is and what the backend
 * authorizes against.
 */
async function buildUserFromSession(): Promise<User | null> {
  const session = await fetchAuthSession();
  const accessToken = session.tokens?.accessToken;
  if (!accessToken) return null;

  try {
    const userId = extractUserIdFromAccessToken(accessToken.toString());
    const current = await getCurrentUser().catch(() => null);
    return {
      userId,
      username: current?.username ?? accessToken.payload['username']?.toString() ?? '',
    };
  } catch (err) {
    logger.warn('Failed to build user from access token:', err);
    return null;
  }
}

/**
 * Auth service singleton.
 *
 * Exported as an object (not a class) because there is no per-instance state
 * — all persistent state lives in Amplify's internal TokenProvider.
 */
export const authService = {
  /**
   * Return valid tokens for API calls.
   *
   * Amplify automatically exchanges the refresh token if the access token is
   * close to expiry. Pass `forceRefresh: true` from 401 retry paths so the
   * refresh-token exchange happens even when Amplify's clock check thinks the
   * cached access token is still valid (which is the exact failure mode
   * present in the legacy amazon-cognito-identity-js flow).
   *
   * @throws {NotAuthenticatedError} if no session exists or refresh fails.
   */
  async getTokens(opts?: { forceRefresh?: boolean }): Promise<AuthTokens> {
    let session;
    try {
      session = await fetchAuthSession({ forceRefresh: opts?.forceRefresh });
    } catch (err) {
      throw new NotAuthenticatedError(
        err instanceof Error ? err.message : 'Failed to fetch auth session'
      );
    }

    const accessToken = session.tokens?.accessToken;
    const idToken = session.tokens?.idToken;

    if (!accessToken || !idToken) {
      throw new NotAuthenticatedError('No valid session');
    }

    const accessTokenStr = accessToken.toString();
    return {
      accessToken: accessTokenStr,
      idToken: idToken.toString(),
      userId: extractUserIdFromAccessToken(accessTokenStr),
      expiresAt: (Number(accessToken.payload['exp']) || 0) * 1000,
    };
  },

  /**
   * Return the current authenticated user, or `null` if not signed in.
   *
   * Never throws: callers use this on app bootstrap where a missing session
   * is the expected "guest" state.
   */
  async currentUser(): Promise<User | null> {
    try {
      return await buildUserFromSession();
    } catch (err) {
      logger.warn('currentUser check failed:', err);
      return null;
    }
  },

  async signIn(username: string, password: string): Promise<SignInResult> {
    const result: SignInOutput = await amplifySignIn({
      username,
      password,
    });

    if (result.isSignedIn) {
      const user = await buildUserFromSession();
      if (!user) {
        throw new Error('Sign-in succeeded but session is missing');
      }
      return { kind: 'success', user };
    }

    const step = result.nextStep.signInStep;
    if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      return { kind: 'newPasswordRequired' };
    }
    if (step === 'CONFIRM_SIGN_UP') {
      return { kind: 'confirmSignUpRequired', username };
    }

    // Other challenge steps (MFA, TOTP, etc.) — not supported by this app yet.
    throw new Error(`Unsupported sign-in step: ${step}`);
  },

  /**
   * Complete the `NEW_PASSWORD_REQUIRED` challenge.
   *
   * Amplify keeps the challenge-in-progress state internally, so no
   * caller-side handle (unlike the old CognitoUser approach) is needed.
   */
  async completeNewPassword(newPassword: string): Promise<User> {
    const result = await amplifyConfirmSignIn({ challengeResponse: newPassword });
    if (!result.isSignedIn) {
      throw new Error(`Password change did not complete sign-in: ${result.nextStep.signInStep}`);
    }
    const user = await buildUserFromSession();
    if (!user) throw new Error('Session missing after password change');
    return user;
  },

  async signOut(): Promise<void> {
    await amplifySignOut();
  },

  async signUp(username: string, password: string, email: string): Promise<void> {
    await amplifySignUp({
      username,
      password,
      options: {
        userAttributes: { email },
      },
    });
  },

  async confirmSignUp(username: string, confirmationCode: string): Promise<void> {
    await amplifyConfirmSignUp({ username, confirmationCode });
  },

  async resendSignUpCode(username: string): Promise<void> {
    await amplifyResendSignUpCode({ username });
  },

  async resetPassword(username: string): Promise<void> {
    await amplifyResetPassword({ username });
  },

  async confirmResetPassword(
    username: string,
    confirmationCode: string,
    newPassword: string
  ): Promise<void> {
    await amplifyConfirmResetPassword({ username, confirmationCode, newPassword });
  },

  /**
   * Subscribe to auth lifecycle events.
   *
   * Returns an unsubscribe function. React code wires this into a single
   * `useEffect` at the `AuthProvider` root so the whole app stays reactive
   * to sign-out / refresh-failure without each consumer having to poll.
   */
  onAuthEvent(listener: AuthEventListener): () => void {
    // Amplify v6 does not export `HubCallback` from its public surface, so we
    // rely on structural typing. The payload shape is documented on Amplify's
    // Auth events page: https://docs.amplify.aws/react/build-a-backend/auth/manage-user-session/
    return Hub.listen(
      'auth',
      async ({ payload }: { payload: { event: string; data?: unknown } }) => {
        try {
          switch (payload.event) {
            case 'signedIn': {
              const user = await buildUserFromSession();
              if (user) listener({ type: 'signedIn', user });
              break;
            }
            case 'signedOut': {
              listener({ type: 'signedOut' });
              listener({ type: 'sessionEnded', reason: 'signedOut' });
              break;
            }
            case 'tokenRefresh_failure': {
              // Amplify emits this when refresh-token exchange fails. That is
              // the only "truly stuck" signal the app gets — the previous
              // access token is now unusable and re-login is required.
              listener({ type: 'sessionEnded', reason: 'refreshFailed' });
              break;
            }
            case 'tokenRefresh': {
              // Successful refresh. No UI action required; logged for
              // diagnostic purposes only.
              logger.debug('Token refreshed via Amplify Hub');
              break;
            }
            // Ignore other events (signInWithRedirect, etc.)
          }
        } catch (err) {
          logger.error('Auth Hub listener error:', err);
        }
      }
    );
  },

  /**
   * Utility exposed for rare UUID validation paths (e.g., tests). Not
   * required for production call sites, which obtain UserId from `getTokens()`.
   */
  parseUserId,
};

export type AuthService = typeof authService;
