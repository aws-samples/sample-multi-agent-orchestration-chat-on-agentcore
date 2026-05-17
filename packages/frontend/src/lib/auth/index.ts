/**
 * Barrel for the Auth layer.
 *
 * Importing from this index ensures `configure.ts` runs before `auth-service`
 * is used: Amplify must be configured before any `aws-amplify/auth` call.
 */
import './configure';

export {
  authService,
  NotAuthenticatedError,
  type AuthTokens,
  type AuthEvent,
  type AuthEventListener,
  type SignInResult,
} from './auth-service';
