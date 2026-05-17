/**
 * Amplify Auth configuration.
 *
 * WHY Amplify v6 Auth (not amazon-cognito-identity-js):
 *   - amazon-cognito-identity-js is in maintenance mode and has known issues:
 *     * `getSession()` returns a cached access token as-is when `isValid()` is
 *       true (client-clock based), so it cannot recover from server-side 401s
 *       caused by clock skew, revoked tokens, or Cognito Threat Protection.
 *     * Multi-tab refresh-token rotation is not coordinated, leading to
 *       "Refresh Token has been revoked" races.
 *     * Its Storage interface allows the SDK to see stale access tokens while
 *       another tab is mid-refresh.
 *   - Amplify v6 replaces the SDK with direct OIDC-style calls and coordinates
 *     refresh across tabs via a single in-flight promise. `fetchAuthSession`
 *     accepts `{ forceRefresh: true }` which *always* exchanges the refresh
 *     token, giving API error handlers a real recovery path for 401s.
 *
 * Must be imported exactly once, before any auth call. Done from `main.tsx`.
 */
import { Amplify } from 'aws-amplify';

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID;

if (!userPoolId || !userPoolClientId) {
  // Not throwing: tests and Storybook may import modules that transitively
  // pull this file without real env vars. The Auth layer will throw a clear
  // error on actual auth calls.
  // eslint-disable-next-line no-console
  console.warn(
    'Cognito User Pool environment variables are not set. Authentication will fail until they are provided.'
  );
}

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: userPoolId ?? '',
      userPoolClientId: userPoolClientId ?? '',
      signUpVerificationMethod: 'code',
      loginWith: {
        username: true,
        email: true,
      },
    },
  },
});
