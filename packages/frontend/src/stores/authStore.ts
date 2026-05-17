import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { AuthState, User } from '../types/index';
import { authService } from '../lib/auth';
import { logger } from '../utils/logger';
import { extractErrorMessage } from '../utils/store-helpers';

interface AuthActions {
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signUp: (username: string, password: string, email: string) => Promise<void>;
  confirmSignUp: (username: string, code: string) => Promise<void>;
  resendCode: (username: string) => Promise<void>;
  completeNewPassword: (newPassword: string) => Promise<void>;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setBootstrapped: (bootstrapped: boolean) => void;
  clearError: () => void;
  setNeedsConfirmation: (needs: boolean, username?: string) => void;
  setNeedsNewPassword: (needs: boolean) => void;
}

type AuthStore = AuthState & AuthActions;

/**
 * Authentication store.
 *
 * WHY no persist middleware:
 *   - Amplify's TokenProvider is the single source of truth for whether the
 *     user is signed in. Persisting `isAuthenticated=true` in Zustand would
 *     let the UI render authenticated screens against a non-existent session
 *     (e.g. refresh token revoked in another tab) and is the failure mode
 *     the pre-Amplify version suffered from.
 *   - On bootstrap `authService.currentUser()` reads Amplify's authoritative
 *     state directly and seeds the store; subsequent changes flow in through
 *     the Amplify Hub listener in `App.tsx`.
 */
export const useAuthStore = create<AuthStore>()(
  devtools(
    (set, get) => ({
      // State
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isBootstrapped: false,
      error: null,
      needsConfirmation: false,
      pendingUsername: null,
      needsNewPassword: false,

      // Actions
      login: async (username, password) => {
        try {
          set({ isLoading: true, error: null });

          const result = await authService.signIn(username, password);

          if (result.kind === 'newPasswordRequired') {
            set({
              needsNewPassword: true,
              pendingUsername: username,
              isLoading: false,
              error: null,
            });
            return;
          }

          if (result.kind === 'confirmSignUpRequired') {
            set({
              needsConfirmation: true,
              pendingUsername: result.username,
              isLoading: false,
              error: null,
            });
            return;
          }

          // WHY explicitly store PasswordCredential: Chrome/Edge's password
          // save heuristic fires on a real form POST + navigation, which
          // SPAs never produce. Calling `navigator.credentials.store()` with
          // a `PasswordCredential` asks the browser to save and later
          // autofill on the next visit. Safari ignores this API and uses
          // the DOM form heuristic from LoginForm.tsx.
          if (
            typeof window !== 'undefined' &&
            'credentials' in navigator &&
            'PasswordCredential' in window
          ) {
            try {
              const PasswordCredentialCtor = (
                window as unknown as {
                  PasswordCredential: new (data: {
                    id: string;
                    password: string;
                    name?: string;
                  }) => Credential;
                }
              ).PasswordCredential;
              const cred = new PasswordCredentialCtor({
                id: username,
                password,
                name: result.user.username,
              });
              await navigator.credentials.store(cred);
            } catch (credErr) {
              logger.warn('Failed to store PasswordCredential:', credErr);
            }
          }

          set({
            user: result.user,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Authentication failed');
          set({
            user: null,
            isAuthenticated: false,
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      logout: async () => {
        try {
          set({ isLoading: true });
          await authService.signOut();
        } catch (error) {
          logger.error('Logout error:', error);
        } finally {
          // Reset state regardless of Amplify signOut outcome. A user who
          // invoked logout must always end up on the guest screen.
          set({
            user: null,
            isAuthenticated: false,
            isLoading: false,
            error: null,
            needsNewPassword: false,
          });
        }
      },

      setUser: (user) => {
        set({
          user,
          isAuthenticated: !!user,
        });
      },

      setLoading: (loading) => set({ isLoading: loading }),

      setBootstrapped: (bootstrapped) => set({ isBootstrapped: bootstrapped }),

      signUp: async (username, password, email) => {
        try {
          set({ isLoading: true, error: null });
          await authService.signUp(username, password, email);
          set({
            isLoading: false,
            error: null,
            needsConfirmation: true,
            pendingUsername: username,
          });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Sign up failed');
          set({
            isLoading: false,
            error: errorMessage,
            needsConfirmation: false,
            pendingUsername: null,
          });
          throw error;
        }
      },

      confirmSignUp: async (username, code) => {
        try {
          set({ isLoading: true, error: null });
          await authService.confirmSignUp(username, code);
          set({
            isLoading: false,
            error: null,
            needsConfirmation: false,
            pendingUsername: null,
          });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Confirmation failed');
          set({
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      resendCode: async (username) => {
        try {
          set({ isLoading: true, error: null });
          await authService.resendSignUpCode(username);
          set({ isLoading: false, error: null });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to resend code');
          set({
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      completeNewPassword: async (newPassword) => {
        const { needsNewPassword } = get();
        if (!needsNewPassword) {
          throw new Error('Password change session not found');
        }

        try {
          set({ isLoading: true, error: null });
          const user = await authService.completeNewPassword(newPassword);
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            error: null,
            needsNewPassword: false,
          });
        } catch (error) {
          const errorMessage = extractErrorMessage(error, 'Failed to change password');
          set({
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      setNeedsConfirmation: (needs, username) => {
        set({
          needsConfirmation: needs,
          pendingUsername: username || null,
        });
      },

      setNeedsNewPassword: (needs) => {
        set({ needsNewPassword: needs });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-store',
      enabled: import.meta.env.DEV,
    }
  )
);
