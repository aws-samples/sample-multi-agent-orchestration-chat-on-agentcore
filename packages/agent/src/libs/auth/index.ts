/**
 * Auth utilities
 */

export {
  REQUIRED_MACHINE_USER_SCOPE,
  validateMachineUserScopes,
  validateTargetUserId,
  resolveEffectiveUserId,
  type ResolveEffectiveUserIdResult,
} from './auth-resolver.js';

export {
  JwtVerificationError,
  classifyAccessToken,
  hydrateJwtVerifiers,
  resetJwtVerifiersForTesting,
  verifyAccessToken,
  verifyIdToken,
  type VerifiedAccessTokenPayload,
  type VerifiedIdTokenPayload,
} from './jwt-verifier.js';
